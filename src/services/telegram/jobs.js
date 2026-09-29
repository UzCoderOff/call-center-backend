const prisma = require("../../lib/prisma");
const env = require("../../config/env");
const { firmNow, shiftDate, isoWeekday, weekStartOf } = require("../../lib/firmTime");
const f = require("./format");
const { notifyUser, linkedUsers, once } = require("./notify");
const { wants } = require("./prefs");
const { myDay } = require("./today");

// Notifications sent on a clock, checked once a minute. Times are the
// firm's (Tashkent). Each check has a window rather than an exact minute,
// so a server restart at 8:31 still sends the 8:30 message — and once()
// makes sure nothing is sent twice.

const at = (h, min = 0) => h * 60 + min;
const WORK_DAYS = [1, 2, 3, 4, 5, 6]; // Monday–Saturday

// Missed calls nobody has called back after N minutes -> the person whose
// phone rang. Only in the daytime (8:00–21:00); calls missed at night come
// in the 8:00 check, one message per person.
const MISSED_LOOKBACK_MS = 12 * 60 * 60 * 1000;

async function missedCalls(now) {
  if (now.minutes < at(8) || now.minutes >= at(21)) return;
  const newest = BigInt(Date.now() - env.telegram.missedAfterMinutes * 60 * 1000);
  const oldest = BigInt(Date.now() - MISSED_LOOKBACK_MS);
  const calls = await prisma.callLog.findMany({
    where: {
      missed: true,
      followUp: "pending",
      callTimestampMs: { gte: oldest, lte: newest },
      employee: { active: true, collectCalls: true, user: { is: { telegram: { is: { chatId: { not: null } } } } } },
    },
    select: { id: true, phoneNumber: true, callTimestampMs: true, employee: { select: { userId: true } } },
    orderBy: { callTimestampMs: "asc" },
    take: 200,
  });
  const byUser = new Map();
  for (const call of calls) {
    const list = byUser.get(call.employee.userId) || [];
    list.push(call);
    byUser.set(call.employee.userId, list);
  }
  for (const [userId, list] of byUser) {
    const user = await prisma.user.findUnique({ where: { id: userId }, include: { employee: true, calendar: true, telegram: true } });
    if (!user || !wants(user, "missedCalls")) continue;
    const fresh = [];
    for (const call of list) {
      if (await once(`missed:${call.id}`, async () => true)) fresh.push(call);
    }
    if (fresh.length === 0) continue;
    const lines = fresh.slice(0, 15).map((c) => {
      const minutes = Math.round((Date.now() - Number(c.callTimestampMs)) / 60000);
      const ago = minutes < 60 ? `${minutes} daqiqa oldin` : `${Math.floor(minutes / 60)} soat oldin`;
      // Written without spaces, so Telegram makes it a tappable number.
      return `• ${f.escapeHtml(f.phoneCompact(c.phoneNumber))} — ${ago}`;
    });
    if (fresh.length > 15) lines.push(`… yana ${fresh.length - 15} ta`);
    const text = [
      `☎️ <b>Javobsiz qoʻngʻiroq${fresh.length > 1 ? `lar (${fresh.length})` : ""} — hali qayta qoʻngʻiroq qilinmagan</b>`,
      ...lines,
      f.portalLink("/calls?view=needsCallback", "Roʻyxatni ochish"),
    ];
    await notifyUser(user, "missedCalls", text.filter(Boolean).join("\n"));
  }
}

// The morning message at 8:30 (until 10:00), Monday–Saturday.
async function digests(now) {
  if (!WORK_DAYS.includes(isoWeekday(now.date)) || now.minutes < at(8, 30) || now.minutes >= at(10)) return;
  for (const user of await linkedUsers()) {
    if (!wants(user, "digest")) continue;
    const text = await myDay(user, { now, morning: true });
    if (!text) continue;
    await once(`digest:${user.id}:${now.date}`, () => notifyUser(user, "digest", text));
  }
}

// 17:30 (until 21:00): the daily report form hasn't been sent yet.
async function reportReminders(now) {
  if (!WORK_DAYS.includes(isoWeekday(now.date)) || now.minutes < at(17, 30) || now.minutes >= at(21)) return;
  // Everyone asked to fill in a form: form only, or automatic + form.
  const people = await linkedUsers({
    employee: { is: { active: true, reportTemplateId: { not: null }, OR: [{ autoReport: false }, { alsoForm: true }] } },
  });
  for (const user of people) {
    if (!wants(user, "reportReminder")) continue;
    const template = await prisma.reportTemplate.findUnique({ where: { id: user.employee.reportTemplateId } });
    if (!template?.active) continue;
    const sent = await prisma.report.findUnique({
      where: { employeeId_templateId_date: { employeeId: user.employee.id, templateId: template.id, date: now.date } },
    });
    if (sent) continue;
    await once(`report:${user.id}:${now.date}`, () =>
      notifyUser(user, "reportReminder", [`📝 <b>Bugungi hisobot hali topshirilmagan</b>`, f.escapeHtml(template.name), f.portalLink("/reports", "Hisobotni toʻldirish")].filter(Boolean).join("\n"))
    );
  }
}

// Thursday and Friday from 10:00: next week isn't confirmed, so nobody can
// book clients into it yet.
async function planningReminders(now) {
  const weekday = isoWeekday(now.date);
  if ((weekday !== 4 && weekday !== 5) || now.minutes < at(10) || now.minutes >= at(18)) return;
  const nextWeek = shiftDate(weekStartOf(now.date), 7);
  const owners = await linkedUsers({ calendar: { is: { active: true } } });
  for (const user of owners) {
    if (!wants(user, "planning")) continue;
    const week = await prisma.calendarWeek.findUnique({ where: { calendarId_weekStart: { calendarId: user.calendar.id, weekStart: nextWeek } } });
    if (week?.status === "published") continue;
    await once(`planning:${user.id}:${now.date}`, () =>
      notifyUser(
        user,
        "planning",
        [
          `⚠️ <b>Keyingi hafta jadvali tasdiqlanmagan</b>`,
          `${f.day(nextWeek)} dan boshlanadigan hafta. Tasdiqlamaguningizcha xodimlar mijoz yoza olmaydi.`,
          f.portalLink("/calendar", "Jadvalni ochish"),
        ]
          .filter(Boolean)
          .join("\n")
      )
    );
  }
}

// Tasks: a reminder an hour before they're due, and one when they're due
// (for up to half a day after, so a restart doesn't lose it). Each once.
async function taskReminders() {
  const { taskText, taskButton, TASK_INCLUDE } = require("./listeners");
  const now = Date.now();
  const soon = await prisma.task.findMany({
    where: { doneAt: null, dueAt: { gt: new Date(now), lte: new Date(now + 60 * 60 * 1000) }, createdAt: { lt: new Date(now - 5 * 60 * 1000) } },
    include: TASK_INCLUDE,
  });
  for (const task of soon) {
    await once(`task-soon:${task.id}`, () => notifyUser(task.assigneeId, "tasks", taskText(task, "⏰ <b>Vazifa muddati yaqin</b>"), taskButton(task.id)));
  }
  const due = await prisma.task.findMany({
    where: { doneAt: null, dueAt: { lte: new Date(now), gt: new Date(now - 12 * 60 * 60 * 1000) } },
    include: TASK_INCLUDE,
  });
  for (const task of due) {
    await once(`task-due:${task.id}`, () => notifyUser(task.assigneeId, "tasks", taskText(task, "⚠️ <b>Vazifa muddati keldi</b>"), taskButton(task.id)));
  }
}

// The "already sent" list only needs to remember a few weeks.
async function cleanup(now) {
  if (now.minutes !== at(4)) return;
  await prisma.telegramNotice.deleteMany({ where: { sentAt: { lt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) } } });
}

const JOBS = { missedCalls, digests, reportReminders, planningReminders, taskReminders, cleanup };

let running = false;
async function tick() {
  if (running) return; // the previous check is still going
  running = true;
  const now = firmNow();
  try {
    for (const [name, job] of Object.entries(JOBS)) {
      try {
        await job(now);
      } catch (err) {
        console.error(`[telegram] ${name} failed:`, err.message);
      }
    }
  } finally {
    running = false;
  }
}

function start() {
  setTimeout(tick, 20 * 1000).unref();
  setInterval(tick, 60 * 1000).unref();
}

module.exports = { start, tick, ...JOBS };
