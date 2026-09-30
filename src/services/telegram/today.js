const prisma = require("../../lib/prisma");
const env = require("../../config/env");
const { firmNow, firmDayRange, shiftDate, isoWeekday, weekStartOf } = require("../../lib/firmTime");
const { computeCallStats } = require("../stats");
const m = require("../materials");
const f = require("./format");
const { isManagerUser, ownsCalendar, booksAppointments } = require("./prefs");
const { canSeeFinance } = require("../../lib/finance");
const { clientScope } = require("../../lib/clientAccess");

// "My day" for one person — the morning message and the bot's "Bugun"
// button: their appointments, clients to call, missed calls to return,
// materials to read; for managers, yesterday in numbers. Each person sees
// only what the portal already shows them.

const canSeeClients = (user) =>
  isManagerUser(user) || user.role === "LAWYER" || Boolean(user.employee?.collectCalls) || user.employee?.calendarAccess === "book";

// A day's appointments: in their own calendar (the lawyer), or the ones
// they booked (staff).
async function appointmentLines(user, date, now) {
  const own = ownsCalendar(user);
  if (!own && !booksAppointments(user)) return [];
  const rows = await prisma.appointment.findMany({
    where: {
      date,
      status: "booked",
      calendar: { active: true },
      ...(own ? { calendarId: user.calendar.id } : isManagerUser(user) ? {} : { bookedById: user.id }),
    },
    include: { calendar: { select: { name: true } } },
    orderBy: [{ start: "asc" }],
    take: 30,
  });
  const upcoming = date === now.date ? rows.filter((a) => a.end > now.minutes) : rows;
  if (upcoming.length === 0) return [];
  const showCalendar = !own;
  return [
    `🗓 <b>Uchrashuvlar (${upcoming.length})</b>`,
    ...upcoming.map((a) => {
      const bits = [f.escapeHtml(a.clientName), a.matter ? f.escapeHtml(a.matter) : null, showCalendar ? f.escapeHtml(a.calendar.name) : null].filter(Boolean);
      return `${f.clock(a.start)} — ${bits.join(" · ")}`;
    }),
  ];
}

async function clientLines(user, date) {
  if (!canSeeClients(user)) return [];
  const end = new Date(firmDayRange(date).to);
  // Only the clients this person may see (their own, for staff and lawyers).
  const where = { AND: [{ archivedAt: null, nextCallAt: { not: null, lte: end } }, clientScope(user)] };
  const total = await prisma.client.count({ where });
  if (total === 0) return [];
  return [`📞 Bugun qoʻngʻiroq qilinadigan mijozlar: <b>${total}</b> ta`];
}

// Missed calls on their own phone that still wait for a call back.
async function missedLines(user, now) {
  if (!user.employee?.collectCalls) return [];
  const since = BigInt(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const count = await prisma.callLog.count({
    where: { employeeId: user.employee.id, missed: true, followUp: "pending", callTimestampMs: { gte: since } },
  });
  return count > 0 ? [`☎️ Qayta qoʻngʻiroq kutayotgan javobsiz qoʻngʻiroqlar: <b>${count}</b> ta`] : [];
}

async function materialLines(user) {
  if (isManagerUser(user)) return [];
  const materials = await prisma.material.findMany({
    where: { archivedAt: null, published: true, required: true },
    include: { audience: true, reads: { where: { userId: user.id } } },
  });
  const person = { ...user, employee: user.employee };
  const unread = materials.filter((mat) => m.inAudience(mat, person) && !m.isRead(mat, mat.reads[0]));
  if (unread.length === 0) return [];
  return [`📘 Oʻqilishi kerak boʻlgan materiallar: <b>${unread.length}</b> ta — ${unread.slice(0, 3).map((mat) => f.escapeHtml(mat.title)).join(", ")}`];
}

// Open tasks due today or already late.
async function taskLines(user, now) {
  const end = new Date(firmDayRange(now.date).to);
  const tasks = await prisma.task.findMany({
    where: { assigneeId: user.id, doneAt: null, dueAt: { lte: end } },
    orderBy: { dueAt: "asc" },
    take: 10,
  });
  if (tasks.length === 0) return [];
  const late = tasks.filter((t) => t.dueAt.getTime() < Date.now()).length;
  return [
    `📌 <b>Vazifalar (${tasks.length})</b>${late ? ` — muddati oʻtgan: ${late}` : ""}`,
    ...tasks.map((t) => `${f.moment(t.dueAt, now.date)} — ${f.escapeHtml(t.title)}`),
  ];
}

async function planningLines(user, now) {
  if (!ownsCalendar(user) || isoWeekday(now.date) < 4) return [];
  const nextWeek = shiftDate(weekStartOf(now.date), 7);
  const week = await prisma.calendarWeek.findUnique({ where: { calendarId_weekStart: { calendarId: user.calendar.id, weekStart: nextWeek } } });
  return week?.status === "published" ? [] : ["⚠️ Keyingi hafta jadvali hali tasdiqlanmagan — xodimlar mijoz yoza olmaydi."];
}

// Yesterday for the boss: calls, missed calls not returned, new
// consultations and contracts, money received, missing reports.
async function managerLines(user, now) {
  if (!isManagerUser(user)) return [];
  const yesterday = shiftDate(now.date, -1);
  const { from, to } = firmDayRange(yesterday);
  const [{ totals }, consultations, contracts, payments, pendingMissed] = await Promise.all([
    computeCallStats({ from, to }),
    prisma.clientCase.count({ where: { consultationDate: yesterday } }),
    prisma.clientCase.count({ where: { contractDate: yesterday } }),
    prisma.payment.aggregate({ where: { date: yesterday }, _sum: { amount: true } }),
    prisma.callLog.count({ where: { missed: true, followUp: "pending", callTimestampMs: { gte: BigInt(from), lte: BigInt(to) } } }),
  ]);
  const lines = [`📊 <b>Kecha (${f.day(yesterday)})</b>`];
  lines.push(`Qoʻngʻiroqlar: ${totals.totalCalls}, javobsiz: ${totals.missedCalls}${pendingMissed > 0 ? ` (hali qayta qoʻngʻiroq qilinmagan: ${pendingMissed})` : ""}`);
  lines.push(`Konsultatsiyalar: ${consultations}, shartnomalar: ${contracts}`);
  // Money from clients: only for people with the "Moliya" switch.
  const paid = payments._sum.amount || 0;
  if (paid > 0 && canSeeFinance(user)) lines.push(`Toʻlovlar: ${f.money(paid)}`);
  return lines;
}

function greeting(user) {
  const first = f.personName(user).split(" ")[0];
  return `Xayrli tong, ${f.escapeHtml(first)}!`;
}

// The morning message; null when there's nothing to say (then nothing is
// sent — except to managers, who always get yesterday's numbers).
async function myDay(user, { now = firmNow(), morning = false } = {}) {
  const sections = [
    await managerLines(user, now),
    await taskLines(user, now),
    await appointmentLines(user, now.date, now),
    await clientLines(user, now.date),
    await missedLines(user, now),
    await materialLines(user),
    await planningLines(user, now),
  ].filter((s) => s.length > 0);

  if (sections.length === 0) return morning ? null : "Bugun siz uchun rejada hech narsa yoʻq. 👍";
  const head = morning ? `${greeting(user)} Bugun — ${f.day(now.date)}.` : `<b>Bugun — ${f.day(now.date)}</b>`;
  const link = env.portalUrl ? `\n\n${f.portalLink("/")}` : "";
  return `${head}\n\n${sections.map((s) => s.join("\n")).join("\n\n")}${link}`;
}

async function tomorrow(user, { now = firmNow() } = {}) {
  const date = shiftDate(now.date, 1);
  const lines = await appointmentLines(user, date, now);
  if (lines.length === 0) {
    return ownsCalendar(user) || booksAppointments(user)
      ? `Ertaga (${f.day(date)}) uchrashuvlar yoʻq.`
      : "Ertangi uchrashuvlar faqat kalendar bilan ishlaydiganlarga koʻrinadi.";
  }
  return `<b>Ertaga — ${f.day(date)}</b>\n\n${lines.join("\n")}`;
}

module.exports = { myDay, tomorrow };
