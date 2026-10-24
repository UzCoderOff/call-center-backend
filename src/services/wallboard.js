const crypto = require("crypto");
const prisma = require("../lib/prisma");
const { getSetting, setSetting } = require("../lib/settings");
const { firmNow, firmDayRange } = require("../lib/firmTime");
const { jobWhere } = require("../lib/jobs");
const { CALL_JOBS, callsMatter } = require("../lib/calling");
const { computeCallStats } = require("./stats");
const { workingDates } = require("./workdays");

// The call center (and the coordinators, who are on the line too) on the
// office TV (the user's pick, 2026-10-24): a page
// that needs no login — a long secret link a manager makes in Settings and
// can replace or switch off — showing the day as it goes: who is talking
// right now, how many are waiting, today's calls, missed ones not called
// back, consultations booked, and each operator's numbers and stars.
//
// It's on a screen anyone in the office can see, so no client names or
// numbers: only staff names and counts — the next consultation shows its
// time, the lawyer, office or video, and who booked it.

const nameOf = (u) => u?.employee?.name || u?.name || u?.username || null;

// The consultation going on now or coming next (today, else the next day
// with one), and how many more today after it.
async function nextConsultation(firm) {
  const rows = await prisma.appointment.findMany({
    where: {
      status: { not: "cancelled" },
      OR: [{ date: firm.date, end: { gt: firm.minutes }, status: "booked" }, { date: { gt: firm.date }, status: "booked" }],
    },
    orderBy: [{ date: "asc" }, { start: "asc" }],
    take: 30,
    select: {
      date: true,
      start: true,
      end: true,
      format: true,
      calendar: { select: { name: true, owner: { select: { name: true, username: true, employee: { select: { name: true } } } } } },
      bookedBy: { select: { name: true, username: true, employee: { select: { name: true } } } },
    },
  });
  const first = rows[0];
  if (!first) return { next: null, moreToday: 0 };
  const sameDay = rows.filter((a) => a.date === firm.date);
  return {
    next: {
      date: first.date,
      start: first.start,
      end: first.end,
      today: first.date === firm.date,
      now: first.date === firm.date && first.start <= firm.minutes,
      inMinutes: first.date === firm.date ? Math.max(0, first.start - firm.minutes) : null,
      online: first.format === "online",
      lawyer: first.calendar?.name || nameOf(first.calendar?.owner) || null,
      bookedBy: nameOf(first.bookedBy),
    },
    moreToday: Math.max(0, sameDay.length - (first.date === firm.date ? 1 : 0)),
  };
}

const SETTING = "wallboard";

async function link() {
  const s = await getSetting(SETTING, {});
  return s.token ? { token: s.token, createdAt: s.createdAt } : null;
}

// A new link (the old one stops working), or none.
async function renew(user) {
  const token = crypto.randomBytes(24).toString("base64url");
  await setSetting(SETTING, { token, createdAt: new Date().toISOString() }, user.id);
  return link();
}

async function revoke(user) {
  await setSetting(SETTING, {}, user.id);
}

async function validToken(token) {
  const s = await getSetting(SETTING, {});
  if (!s.token || typeof token !== "string") return false;
  const given = Buffer.from(token);
  const wanted = Buffer.from(s.token);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

// Who is on a call right now (Ledger's line): ext -> "talking" | "ringing",
// and how many callers wait in line. Empty when the line is off.
async function lineNow() {
  const state = require("./pbx/state");
  if (!state.enabled || !state.ami?.ready) return { on: false, byExt: new Map(), waiting: 0, talking: 0 };
  const live = require("./pbx/live");
  const channels = (await state.ami.actionList({ Action: "CoreShowChannels" })).filter((e) => e.Event === "CoreShowChannel");
  const calls = live.liveCalls(channels);
  const byExt = new Map();
  for (const c of calls) for (const e of c.exts) if (byExt.get(e.ext)?.state !== "talking") byExt.set(e.ext, { state: e.state, seconds: c.seconds });
  return { on: true, byExt, waiting: calls.filter((c) => c.state === "waiting").length, talking: calls.filter((c) => c.state === "talking").length };
}

async function data(now = new Date()) {
  const firm = firmNow(now);
  const day = firmDayRange(firm.date);
  const people = (
    await prisma.employee.findMany({
      where: { active: true, ...jobWhere(CALL_JOBS) },
      select: { id: true, name: true, userId: true, job: true, extraJobs: true, workDays: true, holidaysOff: true, pbx: { select: { ext: true } } },
      orderBy: { name: "asc" },
    })
  ).filter(callsMatter);
  const ids = people.map((e) => e.id);
  const userIds = people.map((e) => e.userId).filter(Boolean);
  const [stats, line, days, booked, bookedByUser, consultsToday, rated, upcoming] = await Promise.all([
    computeCallStats({ employeeIds: ids, from: day.from, to: day.to }),
    lineNow().catch(() => ({ on: false, byExt: new Map(), waiting: 0, talking: 0 })),
    workingDates(people, firm.date, firm.date),
    prisma.appointment.count({ where: { createdAt: { gte: new Date(day.from), lte: new Date(day.to) }, status: { not: "cancelled" } } }),
    prisma.appointment.groupBy({ by: ["bookedById"], where: { bookedById: { in: userIds }, createdAt: { gte: new Date(day.from), lte: new Date(day.to) }, status: { not: "cancelled" } }, _count: { _all: true } }),
    prisma.appointment.count({ where: { date: firm.date, status: { not: "cancelled" } } }),
    require("./callRating").ratings(ids, now),
    nextConsultation(firm),
  ]);
  const bookedBy = new Map(bookedByUser.map((r) => [r.bookedById, r._count._all]));
  const t = stats.totals;
  const operators = people.map((e) => {
    const s = stats.byEmployee.get(e.id);
    const on = e.pbx ? line.byExt.get(e.pbx.ext) : null;
    const away = days.byEmployee.get(e.id)?.off[0] || null;
    const r = rated.get(e.id);
    return {
      name: e.name,
      status: on ? on.state : away ? "away" : "free",
      onCallSeconds: on?.state === "talking" ? on.seconds : null,
      calls: s?.totalCalls || 0,
      answered: s ? s.totalCalls - s.missedCalls : 0,
      missed: s?.missedCalls || 0,
      talkMinutes: s ? Math.round(s.talkSeconds / 60) : 0,
      booked: (e.userId && bookedBy.get(e.userId)) || 0,
      stars: r?.enough ? r.stars : null,
    };
  });
  return {
    now: { date: firm.date, minutes: firm.minutes },
    line: { on: line.on, talking: line.talking, waiting: line.waiting },
    today: {
      calls: t.totalCalls,
      incoming: t.incomingCalls,
      outgoing: t.outgoingCalls,
      answered: t.totalCalls - t.missedCalls,
      missed: t.missedCalls,
      notCalledBack: t.followUp.needsCallback,
      talkMinutes: Math.round(t.talkSeconds / 60),
      booked,
      consultationsToday: consultsToday,
    },
    operators: operators.sort((a, b) => b.booked - a.booked || b.calls - a.calls),
    nextConsultation: upcoming.next,
    moreConsultationsToday: upcoming.moreToday,
  };
}

module.exports = { link, renew, revoke, validToken, data };
