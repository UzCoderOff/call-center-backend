const prisma = require("../../lib/prisma");
const { worksOn } = require("../workdays");
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
  // With the late call-back rule on (services/strikes.js): sooner — half the
  // time it allows — and saying by when.
  const { strikeRules } = require("../strikes");
  const rules = await strikeRules();
  const afterMinutes = rules.enabled ? Math.min(env.telegram.missedAfterMinutes, Math.max(2, Math.floor(rules.minutes / 2))) : env.telegram.missedAfterMinutes;
  const newest = BigInt(Date.now() - afterMinutes * 60 * 1000);
  const oldest = BigInt(Date.now() - MISSED_LOOKBACK_MS);
  const calls = await prisma.callLog.findMany({
    where: {
      missed: true,
      followUp: "pending",
      callTimestampMs: { gte: oldest, lte: newest },
      // The call center's job (Employee.job): someone else's monitored phone
      // isn't a sales line to call back from.
      employee: { active: true, collectCalls: true, job: "call_center", user: { is: { telegram: { is: { chatId: { not: null } } } } } },
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
      const by = rules.enabled ? ` · ${f.clock(firmNow(new Date(Number(c.callTimestampMs) + rules.minutes * 60000)).minutes)} gacha` : "";
      return `• ${f.escapeHtml(f.phoneCompact(c.phoneNumber))} — ${ago}${by}`;
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
  // Each person on their own working days (checked below), not just Mon–Sat.
  if (now.minutes < at(17, 30) || now.minutes >= at(21)) return;
  // Everyone asked to fill in a form: form only, or automatic + form.
  const people = await linkedUsers({
    employee: { is: { active: true, reportTemplateId: { not: null }, OR: [{ autoReport: false }, { alsoForm: true }] } },
  });
  for (const user of people) {
    if (!wants(user, "reportReminder")) continue;
    // Not on their day off, a holiday off for them, or a day away.
    if (!(await worksOn(user.employee, now.date))) continue;
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

// 10:00 (until 13:00), Monday–Saturday: phones that aren't recording calls
// (src/services/syncHealth.js) -> the person whose phone it is, with how to
// switch recording on, and the managers, one list. Once a day while it lasts.
const RECORDING_PROBLEMS = ["none", "noAccess"];

function recordingLine(r) {
  return r.status === "noAccess" ? "ilovaga fayllarni oʻqishga ruxsat berilmagan" : `oxirgi 7 kunda ${r.calls7d} ta qoʻngʻiroqdan ${r.recorded7d} tasi yozilgan`;
}

async function recordingAlerts(now) {
  if (!WORK_DAYS.includes(isoWeekday(now.date)) || now.minutes < at(10) || now.minutes >= at(13)) return;
  const { getRecordingHealth } = require("../syncHealth");
  const employees = await prisma.employee.findMany({ where: { active: true, collectCalls: true }, select: { id: true, name: true, employeeId: true, userId: true } });
  const health = await getRecordingHealth(employees);
  const bad = employees.filter((e) => RECORDING_PROBLEMS.includes(health.get(e.id)?.status));
  if (bad.length === 0) return;

  for (const e of bad) {
    if (!e.userId) continue;
    const r = health.get(e.id);
    const text = [
      "📵 <b>Telefoningiz qoʻngʻiroqlarni yozib olmayapti</b>",
      `${recordingLine(r)}.`,
      r.status === "noAccess"
        ? "Ledger ilovasida: Profil → «Telefonni sozlash» → yozuvlarga ruxsat bering."
        : "Telefon ilovasining sozlamalarida avtomatik yozib olishni yoqing. Qadamma-qadam: Ledger ilovasi → Profil → «Telefonni sozlash».",
    ].join("\n");
    await once(`recording:${e.id}:${now.date}`, () => notifyUser(e.userId, "recordings", text));
  }

  const managers = await linkedUsers({ role: { in: ["BOSS", "DEVELOPER"] } });
  const list = bad.map((e) => `• ${f.escapeHtml(e.name)} — ${recordingLine(health.get(e.id))}`);
  const text = [`📵 <b>Qoʻngʻiroqlarni yozib olmayotgan telefonlar (${bad.length})</b>`, ...list, f.portalLink("/team", "Xodimlarni ochish")].filter(Boolean).join("\n");
  for (const user of managers) {
    await once(`recordings:${user.id}:${now.date}`, () => notifyUser(user, "recordings", text));
  }
}

// 9:00 (until 12:00) daily: the server's disk is nearly full -> the
// developers. Recordings are never deleted, so this only grows.
async function diskAlerts(now) {
  if (now.minutes < at(9) || now.minutes >= at(12)) return;
  const { diskSpace } = require("../diskSpace");
  const disk = await diskSpace();
  if (!disk?.low) return;
  const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1).replace(".", ",");
  const text = [
    "💽 <b>Serverda joy kam qoldi</b>",
    `Boʻsh: ${gb(disk.freeBytes)} GB (${Math.round((disk.freeShare || 0) * 100)}%), jami ${gb(disk.totalBytes)} GB.`,
    "Joy tugasa, telefonlardan maʼlumot kelmay qoladi. Eski yozuvlarni Google Drive nusxasiga koʻchirib, serverdan oʻchirish yoki diskni kattalashtirish kerak.",
  ].join("\n");
  for (const user of await linkedUsers({ role: "DEVELOPER" })) {
    await once(`disk:${user.id}:${now.date}`, () => notifyUser(user, null, text));
  }
}

// Follow-ups that have come due -> whoever must do them (or, with nobody
// assigned, the operator / coordinator of the client's latest case). Once
// each; ones more than two hours overdue when first seen aren't sent (a
// restart or an update doesn't flood anyone).
async function followUpReminders() {
  const { followUpText, followUpButton, FOLLOW_UP_MESSAGE_INCLUDE } = require("./listeners");
  const now = Date.now();
  const due = await prisma.clientFollowUp.findMany({
    where: { status: "open", remindedAt: null, dueAt: { lte: new Date(now), gte: new Date(now - 2 * 60 * 60 * 1000) }, client: { archivedAt: null } },
    include: { ...FOLLOW_UP_MESSAGE_INCLUDE, client: { select: { ...FOLLOW_UP_MESSAGE_INCLUDE.client.select, cases: { orderBy: { updatedAt: "desc" }, take: 1, select: { operator: { select: { userId: true } }, coordinator: { select: { userId: true } } } } } } },
    take: 100,
  });
  for (const row of due) {
    const latest = row.client.cases[0];
    const to = row.assigneeId ?? latest?.coordinator?.userId ?? latest?.operator?.userId ?? null;
    await prisma.clientFollowUp.update({ where: { id: row.id }, data: { remindedAt: new Date() } });
    if (to) await once(`followup:${row.id}`, () => notifyUser(to, "followUps", followUpText(row, "⏰ <b>Eslatma — vaqti keldi</b>"), followUpButton(row.id)));
  }
}

// The "already sent" list only needs to remember a few weeks.
async function cleanup(now) {
  if (now.minutes !== at(4)) return;
  await prisma.telegramNotice.deleteMany({ where: { sentAt: { lt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000) } } });
}

const JOBS = { missedCalls, digests, reportReminders, planningReminders, taskReminders, followUpReminders, recordingAlerts, diskAlerts, cleanup };

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
