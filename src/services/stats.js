const prisma = require("../lib/prisma");

// Call statistics for the dashboard and the employee detail page. A fixed
// number of grouped queries no matter how many employees there are, rather
// than a handful of queries per employee.

const FOLLOW_UP_FIELD = {
  called_back: "calledBack",
  client_called_again: "clientCalledAgain",
  handled: "handled",
  attempted: "attempted",
  pending: "pending",
  no_number: "noNumber",
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SERIES_DAYS = 92;

function blankStats() {
  return {
    totalCalls: 0,
    answeredCalls: 0,
    missedCalls: 0,
    talkSeconds: 0,
    followUp: {
      calledBack: 0,
      clientCalledAgain: 0,
      handled: 0,
      attempted: 0,
      pending: 0,
      noNumber: 0,
      // Derived, filled in by finalize():
      reached: 0, // calledBack + clientCalledAgain + handled
      needsCallback: 0, // attempted + pending
      // Median delay of "called_back" only — how fast *we* typically call
      // back. Median, not mean: one callback three days later shouldn't
      // make a team that usually calls back in 10 minutes look slow.
      medianCallbackSec: null,
    },
  };
}

function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function timeWhere(from, to) {
  if (from == null && to == null) return {};
  const range = {};
  if (from != null) range.gte = BigInt(from);
  if (to != null) range.lte = BigInt(to);
  return { callTimestampMs: range };
}

function finalize(stats, delays) {
  stats.answeredCalls = stats.totalCalls - stats.missedCalls;
  const f = stats.followUp;
  f.reached = f.calledBack + f.clientCalledAgain + f.handled;
  f.needsCallback = f.attempted + f.pending;
  f.medianCallbackSec = median(delays);
  return stats;
}

// employeeIds: array of Employee.id to include, or null for everyone.
// Returns { totals, byEmployee: Map<employeeId, stats> }.
async function computeCallStats({ employeeIds = null, from, to }) {
  const where = {
    ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
    ...timeWhere(from, to),
  };

  const [volume, followUps, delays] = await Promise.all([
    prisma.callLog.groupBy({
      by: ["employeeId", "missed"],
      where,
      _count: { _all: true },
      _sum: { durationSeconds: true },
    }),
    prisma.callLog.groupBy({
      by: ["employeeId", "followUp"],
      where: { ...where, missed: true },
      _count: { _all: true },
    }),
    prisma.callLog.findMany({
      where: { ...where, missed: true, followUp: "called_back", followUpDelaySec: { not: null } },
      select: { employeeId: true, followUpDelaySec: true },
    }),
  ]);

  const byEmployee = new Map();
  const statsFor = (id) => {
    if (!byEmployee.has(id)) byEmployee.set(id, blankStats());
    return byEmployee.get(id);
  };

  for (const row of volume) {
    const s = statsFor(row.employeeId);
    s.totalCalls += row._count._all;
    if (row.missed) s.missedCalls += row._count._all;
    s.talkSeconds += row._sum.durationSeconds || 0;
  }
  for (const row of followUps) {
    // A missed call with no status yet is, by definition, still waiting.
    const field = FOLLOW_UP_FIELD[row.followUp ?? "pending"];
    if (field) statsFor(row.employeeId).followUp[field] += row._count._all;
  }

  const delaysByEmployee = new Map();
  for (const row of delays) {
    if (!delaysByEmployee.has(row.employeeId)) delaysByEmployee.set(row.employeeId, []);
    delaysByEmployee.get(row.employeeId).push(row.followUpDelaySec);
  }

  const totals = blankStats();
  for (const [id, s] of byEmployee) {
    finalize(s, delaysByEmployee.get(id));
    totals.totalCalls += s.totalCalls;
    totals.missedCalls += s.missedCalls;
    totals.talkSeconds += s.talkSeconds;
    for (const field of Object.values(FOLLOW_UP_FIELD)) totals.followUp[field] += s.followUp[field];
  }
  finalize(
    totals,
    delays.map((row) => row.followUpDelaySec)
  );

  return { totals, byEmployee };
}

// Calls per local calendar day, for the dashboard chart. tzOffsetMin is the
// viewer's UTC offset in minutes (Tashkent: +300) so "a day" means the
// viewer's day, not UTC's. Every day in the range is present, zero-filled.
async function computeDailySeries({ employeeIds = null, from, to, tzOffsetMin = 0 }) {
  const end = to ?? Date.now();
  const start = Math.max(from ?? end - 30 * DAY_MS, end - MAX_SERIES_DAYS * DAY_MS);

  const calls = await prisma.callLog.findMany({
    where: {
      ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
      ...timeWhere(start, end),
    },
    select: { callTimestampMs: true, missed: true },
  });

  const offsetMs = tzOffsetMin * 60 * 1000;
  const dayKey = (ms) => new Date(ms + offsetMs).toISOString().slice(0, 10);

  const days = new Map();
  for (let t = start; dayKey(t) <= dayKey(end); t += DAY_MS) {
    days.set(dayKey(t), { date: dayKey(t), total: 0, missed: 0 });
  }
  for (const call of calls) {
    const day = days.get(dayKey(Number(call.callTimestampMs)));
    if (!day) continue;
    day.total += 1;
    if (call.missed) day.missed += 1;
  }
  return [...days.values()];
}

module.exports = { computeCallStats, computeDailySeries, blankStats };
