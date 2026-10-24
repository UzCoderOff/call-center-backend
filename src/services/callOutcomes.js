const prisma = require("../lib/prisma");
const { phoneKey: keyOf } = require("../lib/phone");
const { firmNow, firmDayRange } = require("../lib/firmTime");
const { getSetting, setSetting } = require("../lib/settings");
const { isCallCenter, jobWhere } = require("../lib/jobs");

// What came of new callers who didn't book (2026-10-17; table CallOutcome).
// The call center talks to many new numbers and books few, and nobody wrote
// down why — so after a talk with a NEW number (their first call ever, not a
// client before) that didn't end in a booking, the operator taps one reason:
//
//   price          the price put them off
//   question       they only had a question
//   other_firm     went to another firm / lawyer
//   call_again     they'll call again, or want a call later
//   wrong_number   a wrong number, an ad, nothing to do with the firm
//   not_our_field  a matter the firm doesn't take
//   other          something else — with a word
//
// Not after every call: ten calls from one person are one answer, and
// returning callers and clients aren't asked. A number drops off the list
// once it's booked, has an outcome, or its client card already says how it
// went (a case moved on from "consultation"). Only the call center's phones
// are asked, and only from the day this was switched on (Setting
// "callOutcomes".since) and the last 7 days — older calls are no backlog.

const OUTCOMES = ["price", "question", "other_firm", "call_again", "wrong_number", "not_our_field", "other"];
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SETTING = "callOutcomes";
const connected = (c) => !c.missed && c.durationSeconds > 0;

// From when (epoch ms) new callers are asked about: the start of the day this
// first ran.
async function askedSince(db = prisma) {
  const s = await getSetting(SETTING, {}, db);
  if (Number.isFinite(s.since)) return s.since;
  const since = firmDayRange(firmNow().date).from;
  await setSetting(SETTING, { ...s, since }, null, db);
  return since;
}

// Staff phones aren't callers.
async function staffKeys(db) {
  const rows = await db.employee.findMany({ where: { phoneNumber: { not: null } }, select: { phoneNumber: true } });
  return new Set(rows.map((e) => keyOf(e.phoneNumber)).filter(Boolean));
}

// The call center's people (whose new callers are asked about).
async function callCenterIds(db = prisma) {
  const rows = await db.employee.findMany({ where: { active: true, ...jobWhere(["call_center"]) }, select: { id: true, job: true, extraJobs: true } });
  return rows.filter(isCallCenter).map((e) => e.id);
}

// New numbers these phones talked to from `from` on, that nobody has said
// how it went: [{ phoneKey, phone, firstAt, lastAt, calls, employeeId }],
// newest first.
async function pending({ employeeIds, now = Date.now(), db = prisma }) {
  if (!employeeIds.length) return [];
  const from = Math.max(await askedSince(db), now - WINDOW_MS);
  const calls = await db.callLog.findMany({
    where: { employeeId: { in: employeeIds }, phoneKey: { not: null }, callTimestampMs: { gte: BigInt(from), lte: BigInt(now) } },
    select: { phoneKey: true, phoneNumber: true, missed: true, durationSeconds: true, callTimestampMs: true, employeeId: true },
    orderBy: { callTimestampMs: "asc" },
  });
  const staff = await staffKeys(db);
  const byKey = new Map();
  for (const c of calls) {
    if (staff.has(c.phoneKey)) continue;
    const t = Number(c.callTimestampMs);
    const row = byKey.get(c.phoneKey) || { phoneKey: c.phoneKey, phone: c.phoneNumber, firstAt: t, lastAt: t, calls: 0, talked: false, employeeId: null };
    row.calls += 1;
    row.lastAt = t;
    row.phone = c.phoneNumber || row.phone;
    if (connected(c)) {
      row.talked = true;
      row.employeeId = c.employeeId; // the last of them who talked to them
    }
    byKey.set(c.phoneKey, row);
  }
  // Reached only — a caller nobody talked to is the missed-call list's.
  const keys = [...byKey.values()].filter((r) => r.talked).map((r) => r.phoneKey);
  if (keys.length === 0) return [];
  const [before, phones, outcomes, booked] = await Promise.all([
    // Called (any phone) before the window: not new.
    db.callLog.findMany({ where: { phoneKey: { in: keys }, callTimestampMs: { lt: BigInt(from) } }, select: { phoneKey: true }, distinct: ["phoneKey"] }),
    db.clientPhone.findMany({ where: { phoneKey: { in: keys } }, select: { phoneKey: true, clientId: true, client: { select: { createdAt: true, cases: { select: { status: true } } } } } }),
    db.callOutcome.findMany({ where: { phoneKey: { in: keys } }, select: { phoneKey: true } }),
    db.appointment.findMany({ where: { phoneKey: { in: keys }, status: { not: "cancelled" }, createdAt: { gte: new Date(from - 60 * 60 * 1000) } }, select: { phoneKey: true } }),
  ]);
  const skip = new Set([...before.map((r) => r.phoneKey), ...outcomes.map((r) => r.phoneKey), ...booked.map((r) => r.phoneKey)]);
  // Booked for the client the number belongs to — from the client's card,
  // with another of their numbers or none on the booking (2026-10-24: a
  // caller added as a client and booked was still asked why they didn't book).
  const clientIds = [...new Set(phones.map((p) => p.clientId))];
  if (clientIds.length) {
    const bookedClients = new Set(
      (await db.appointment.findMany({ where: { clientId: { in: clientIds }, status: { not: "cancelled" }, createdAt: { gte: new Date(from - 60 * 60 * 1000) } }, select: { clientId: true } })).map((a) => a.clientId)
    );
    for (const p of phones) if (bookedClients.has(p.clientId)) skip.add(p.phoneKey);
  }
  for (const p of phones) {
    const row = byKey.get(p.phoneKey);
    // A client before they first called this week: not new. One added since
    // whose case already moved on (call again, contract, declined…): the
    // client card says how it went.
    if (p.client.createdAt.getTime() < row.firstAt || p.client.cases.some((k) => k.status !== "consultation")) skip.add(p.phoneKey);
  }
  return keys
    .filter((k) => !skip.has(k))
    .map((k) => {
      const { talked, ...row } = byKey.get(k);
      return row;
    })
    .sort((a, b) => b.lastAt - a.lastAt);
}

// Saves (or, with outcome null, takes back) the outcome for a number —
// credited to `employeeId`, the operator who talked to the caller.
async function record({ user, phoneKey, outcome, note, employeeId = user.employee?.id ?? null, db = prisma }) {
  if (outcome === null) {
    await db.callOutcome.deleteMany({ where: { phoneKey } });
    return null;
  }
  const data = { outcome, note: note || null, employeeId, createdById: user.id };
  return db.callOutcome.upsert({ where: { phoneKey }, create: { phoneKey, ...data }, update: data });
}

module.exports = { OUTCOMES, askedSince, pending, record, callCenterIds, WINDOW_MS };
