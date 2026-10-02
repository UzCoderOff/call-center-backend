const prisma = require("../lib/prisma");
const { firmNow, firmDayRange, shiftDate } = require("../lib/firmTime");
const { phoneKey } = require("../lib/phone");
const { getSetting } = require("../lib/settings");
const { workingDates } = require("./workdays");
const { events } = require("../lib/events");

// Strikes ("ogohlantirish"): a call-center phone missed a call and nobody
// called the number back in time. The firm's rule (Setting "strikes", set by
// the developer):
//   minutes   call back within this many minutes of the missed call
//   from, to  working hours (minutes of the day, firm time): a call missed
//             outside them — or on someone's day off — is due that many
//             minutes after the next opening on a day they work
//   limit     strikes a month before it's "over the limit" (the managers
//             hear about it)
//   fine      soʻm per strike over the limit (0: none) — shown, not
//             deducted anywhere
//   since     only calls missed after the rule was switched on count
//
// "Called back" is any later call with that number from any of the firm's
// phones: an outgoing call (answered or not — they tried), or the client
// calling again and being answered — or the missed call marked handled
// (reached another way). In time: a strike; after the time: a strike, with
// when it was finally returned.
//
// Phones send their calls a few minutes after each call (and hourly), so a
// missed call is only judged once the phone that missed it has sent its calls
// from after the deadline, plus a margin (a colleague's call-back has time to
// arrive). A strike whose call-back turns up later — in time after all — is
// cancelled by itself, marked so. Calls from the firm's own staff numbers,
// and a second missed call from the same number within the hour, don't count.

const STRIKE_DEFAULTS = {
  enabled: false,
  minutes: 10,
  from: 9 * 60,
  to: 20 * 60,
  limit: 3,
  fine: 0,
  since: null,
};

const GRACE_MS = 20 * 60 * 1000;
const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const SAME_NUMBER_MS = 60 * 60 * 1000;
// A phone that hasn't sent anything this long after the deadline: no
// judgement (better no strike than a wrong one).
const GIVE_UP_MS = 48 * 60 * 60 * 1000;

class RuleError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function int(value, field, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new RuleError(`invalid ${field}`);
  return n;
}

// The rule as sent from the portal, checked. Switching it on (again) starts
// counting from now — calls missed before never get strikes.
function normalizeRules(input, current, now = new Date()) {
  const b = input || {};
  const next = { ...STRIKE_DEFAULTS, ...current };
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") throw new RuleError("invalid enabled");
    if (b.enabled && !next.enabled) next.since = now.toISOString();
    next.enabled = b.enabled;
  }
  if (b.minutes !== undefined) next.minutes = int(b.minutes, "minutes", 1, 240);
  if (b.from !== undefined) next.from = int(b.from, "from", 0, 1439);
  if (b.to !== undefined) next.to = int(b.to, "to", 1, 1440);
  if (next.from >= next.to) throw new RuleError("from must be before to");
  if (b.limit !== undefined) next.limit = int(b.limit, "limit", 0, 100);
  if (b.fine !== undefined) next.fine = int(b.fine, "fine", 0, 100_000_000);
  return next;
}

// When a call missed at `missedMs` must be called back by. `works(date)`:
// whether the person works that day (their pattern, holidays, days away).
function deadlineFor(missedMs, rules, works) {
  const at = firmNow(new Date(missedMs));
  const span = rules.minutes * 60 * 1000;
  if (works(at.date) && at.minutes >= rules.from && at.minutes < rules.to) return missedMs + span;
  // Outside working time: from the next opening (today's, if before it).
  let date = works(at.date) && at.minutes < rules.from ? at.date : shiftDate(at.date, 1);
  for (let i = 0; i < 31 && !works(date); i++) date = shiftDate(date, 1);
  return firmDayRange(date).from + rules.from * 60 * 1000 + span;
}

// The first response to a missed call: the earliest later call with that
// number — outgoing (any), or incoming and answered — or the "handled" mark.
// `later`: calls with the same number, any phone. null: none yet.
function firstResponse(missed, later) {
  const t0 = Number(missed.callTimestampMs);
  let best = null;
  for (const c of later) {
    const t = Number(c.callTimestampMs);
    if (t <= t0) continue;
    const responds = c.callType === "outgoing" || (!c.missed && c.durationSeconds > 0);
    if (responds && (best == null || t < best)) best = t;
  }
  if (missed.followUp === "handled" && missed.followUpMarkedAt) {
    const marked = new Date(missed.followUpMarkedAt).getTime();
    if (best == null || marked < best) best = marked;
  }
  return best;
}

// One missed call, judged: { verdict: "ok" | "strike" | "wait" | "skip",
// deadline, answeredAt }. lastSyncMs: when the phone that missed it last sent
// its calls.
function judge({ missed, later, rules, works, lastSyncMs, now }) {
  const deadline = deadlineFor(Number(missed.callTimestampMs), rules, works);
  const answered = firstResponse(missed, later);
  if (answered != null && answered <= deadline) return { verdict: "ok", deadline, answeredAt: answered };
  if (now < deadline + GRACE_MS) return { verdict: "wait", deadline, answeredAt: answered };
  if (answered != null) return { verdict: "strike", deadline, answeredAt: answered };
  // Not returned (as far as we know): only once the phone has sent what
  // happened after the deadline.
  if (lastSyncMs != null && lastSyncMs >= deadline + GRACE_MS) return { verdict: "strike", deadline, answeredAt: null };
  if (now > deadline + GIVE_UP_MS) return { verdict: "skip", deadline, answeredAt: null };
  return { verdict: "wait", deadline, answeredAt: null };
}

async function strikeRules(db = prisma) {
  return getSetting("strikes", STRIKE_DEFAULTS, db);
}

const monthOf = (ms) => firmNow(new Date(ms)).date.slice(0, 7);

// Looks at the recent missed calls of the call center and gives the strikes
// due; cancels strikes whose call-back turned up in time after all. Run every
// few minutes (services/scheduler.js). Returns { created, cancelled }.
async function evaluateStrikes({ now = Date.now(), db = prisma } = {}) {
  const rules = await strikeRules(db);
  if (!rules.enabled || !rules.since) return { created: 0, cancelled: 0 };
  const since = Math.max(new Date(rules.since).getTime(), now - LOOKBACK_MS);

  const missed = await db.callLog.findMany({
    where: {
      missed: true,
      phoneKey: { not: null },
      callTimestampMs: { gte: BigInt(since) },
      employee: { job: "call_center", active: true },
    },
    select: { id: true, employeeId: true, phoneKey: true, callTimestampMs: true, followUp: true, followUpMarkedAt: true, strike: { select: { id: true, cancelledAt: true, cancelReason: true } }, employee: { select: { id: true, employeeId: true, workDays: true, holidaysOff: true } } },
    orderBy: { callTimestampMs: "asc" },
  });
  if (missed.length === 0) return { created: 0, cancelled: 0 };

  // Staff numbers: calls between colleagues don't count.
  const staff = new Set(
    (await db.employee.findMany({ where: { phoneNumber: { not: null } }, select: { phoneNumber: true } })).map((e) => phoneKey(e.phoneNumber)).filter(Boolean)
  );
  const keys = [...new Set(missed.map((c) => c.phoneKey))];
  const calls = await db.callLog.findMany({
    where: { phoneKey: { in: keys }, callTimestampMs: { gte: BigInt(since - SAME_NUMBER_MS) } },
    select: { id: true, phoneKey: true, callType: true, missed: true, durationSeconds: true, callTimestampMs: true },
  });
  const byKey = new Map();
  for (const c of calls) byKey.set(c.phoneKey, [...(byKey.get(c.phoneKey) || []), c]);

  // When each phone last sent its calls.
  const tokens = [...new Set(missed.map((c) => c.employee.employeeId))];
  const syncs = await db.syncLog.groupBy({ by: ["employeeId"], where: { employeeId: { in: tokens }, ok: true }, _max: { createdAt: true } });
  const lastSync = new Map(syncs.map((s) => [s.employeeId, s._max.createdAt?.getTime() ?? null]));

  // Working days of these people, around the window.
  const firstDate = firmNow(new Date(since)).date;
  const lastDate = shiftDate(firmNow(new Date(now)).date, 31);
  const people = [...new Map(missed.map((c) => [c.employee.id, c.employee])).values()];
  const { byEmployee } = await workingDates(people, shiftDate(firstDate, -1), lastDate, db);
  const worksFor = (id) => {
    const set = new Set(byEmployee.get(id)?.work || []);
    return (date) => set.has(date);
  };

  let created = 0;
  let cancelled = 0;
  for (const call of missed) {
    if (staff.has(call.phoneKey)) continue;
    const others = byKey.get(call.phoneKey) || [];
    const t0 = Number(call.callTimestampMs);
    // A second missed call from the same number within the hour: the first
    // one is what counts.
    if (others.some((c) => c.missed && c.id !== call.id && Number(c.callTimestampMs) < t0 && t0 - Number(c.callTimestampMs) < SAME_NUMBER_MS)) continue;
    const result = judge({ missed: call, later: others, rules, works: worksFor(call.employee.id), lastSyncMs: lastSync.get(call.employee.employeeId) ?? null, now });

    if (call.strike) {
      // Returned in time after all (a late sync): cancelled by itself.
      if (!call.strike.cancelledAt && result.verdict === "ok") {
        await db.strike.update({ where: { id: call.strike.id }, data: { cancelledAt: new Date(now), cancelReason: "callback_found", answeredAt: new Date(result.answeredAt) } });
        cancelled += 1;
      }
      continue;
    }
    if (result.verdict !== "strike") continue;
    try {
      const strike = await db.strike.create({
        data: {
          employeeId: call.employeeId,
          callLogId: call.id,
          month: monthOf(t0),
          missedAt: new Date(t0),
          deadlineAt: new Date(result.deadline),
          answeredAt: result.answeredAt != null ? new Date(result.answeredAt) : null,
        },
      });
      created += 1;
      events.emit("strike.created", { strikeId: strike.id });
    } catch (err) {
      if (err.code !== "P2002") throw err; // given meanwhile
    }
  }
  return { created, cancelled };
}

// This month's strikes for these people: Map employeeId -> { count, limit,
// over, fine }. Cancelled ones don't count.
async function strikeCounts(employeeIds, month, db = prisma) {
  const rules = await strikeRules(db);
  const rows = employeeIds.length
    ? await db.strike.groupBy({ by: ["employeeId"], where: { employeeId: { in: employeeIds }, month, cancelledAt: null }, _count: { _all: true } })
    : [];
  const counts = new Map(rows.map((r) => [r.employeeId, r._count._all]));
  const out = new Map();
  for (const id of employeeIds) {
    const count = counts.get(id) || 0;
    const over = Math.max(0, count - rules.limit);
    out.set(id, { count, limit: rules.limit, over, fine: over * rules.fine });
  }
  return { rules, counts: out };
}

module.exports = { STRIKE_DEFAULTS, RuleError, normalizeRules, deadlineFor, firstResponse, judge, strikeRules, evaluateStrikes, strikeCounts, monthOf };
