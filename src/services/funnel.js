const prisma = require("../lib/prisma");
const { firmDate } = require("../lib/firmTime");
const { phoneKey } = require("../lib/phone");

// From calls to contracts, counted by people (phone numbers), not by calls —
// ten calls from one person are one person. For some phones (the call
// center, usually) over a period:
//
//   numbers    different numbers that called or were called
//     new      their first call ever is in the period, and they weren't a
//              client before it (new leads); the rest are returning
//   reached    someone at the firm actually talked to them (an answered
//              call, either way — from any phone) within a week of their
//              first call in the period
//   lost       never talked to: they called, nobody answered, and nobody
//              got through to them since
//   booked     a consultation booked for that number within 30 days
//   came       …and they came
//   signed     a contract signed by that client since the period began
//
// What the lost new numbers could have been worth: each one × the share of
// reached new numbers that booked × the consultation fee — "if they had
// booked like the others did". An estimate, said so on the page.
// Also why the period's consultations didn't continue (lost reasons).

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null);
const connected = (c) => !c.missed && c.durationSeconds > 0;

// employeeIds: whose phones (null: everyone's). from/to: epoch ms.
async function computeFunnel({ employeeIds = null, from, to, fee, now = Date.now(), db = prisma }) {
  const range = { ...(from != null ? { gte: BigInt(from) } : {}), ...(to != null ? { lte: BigInt(to) } : {}) };
  const own = employeeIds ? { employeeId: { in: employeeIds } } : {};
  const calls = await db.callLog.findMany({
    where: { ...own, phoneKey: { not: null }, callTimestampMs: range },
    select: { phoneKey: true, callType: true, missed: true, durationSeconds: true, callTimestampMs: true },
  });
  const staff = new Set(
    (await db.employee.findMany({ where: { phoneNumber: { not: null } }, select: { phoneNumber: true } })).map((e) => phoneKey(e.phoneNumber)).filter(Boolean)
  );

  // Each number's first call in the period.
  const first = new Map();
  for (const c of calls) {
    if (staff.has(c.phoneKey)) continue;
    const t = Number(c.callTimestampMs);
    if (!first.has(c.phoneKey) || t < first.get(c.phoneKey)) first.set(c.phoneKey, t);
  }
  const keys = [...first.keys()];
  const empty = { numbers: 0, new: 0, returning: 0, reached: 0, lost: 0, lostNew: 0, booked: 0, came: 0, signed: 0, rates: {}, fee, expectedLost: 0, lostReasons: [] };
  if (keys.length === 0) return { ...empty, lostReasons: await lostReasons(db, employeeIds, from, to) };

  const start = from ?? Math.min(...first.values());
  const [everCalls, before, clientsBefore, appointments, phones] = await Promise.all([
    // Every call with these numbers from the period on, any phone.
    db.callLog.findMany({ where: { phoneKey: { in: keys }, callTimestampMs: { gte: BigInt(start) } }, select: { phoneKey: true, missed: true, durationSeconds: true, callTimestampMs: true } }),
    // Numbers seen before the period.
    db.callLog.findMany({ where: { phoneKey: { in: keys }, callTimestampMs: { lt: BigInt(start) } }, select: { phoneKey: true }, distinct: ["phoneKey"] }),
    db.clientPhone.findMany({ where: { phoneKey: { in: keys }, client: { createdAt: { lt: new Date(start) } } }, select: { phoneKey: true } }),
    db.appointment.findMany({ where: { phoneKey: { in: keys }, status: { not: "cancelled" }, createdAt: { gte: new Date(start) } }, select: { phoneKey: true, status: true, createdAt: true } }),
    db.clientPhone.findMany({ where: { phoneKey: { in: keys } }, select: { phoneKey: true, client: { select: { cases: { select: { contractDate: true } } } } } }),
  ]);
  const known = new Set([...before.map((r) => r.phoneKey), ...clientsBefore.map((r) => r.phoneKey)]);
  const startDate = firmDate(new Date(start));

  let reached = 0;
  let lost = 0;
  let lostNew = 0;
  let isNew = 0;
  let newReached = 0;
  let newBooked = 0;
  const booked = new Set();
  const came = new Set();
  const signed = new Set();
  const byKey = new Map();
  for (const c of everCalls) byKey.set(c.phoneKey, [...(byKey.get(c.phoneKey) || []), c]);
  const apptsByKey = new Map();
  for (const a of appointments) apptsByKey.set(a.phoneKey, [...(apptsByKey.get(a.phoneKey) || []), a]);
  const signedKeys = new Set(phones.filter((p) => p.client.cases.some((k) => k.contractDate && k.contractDate >= startDate)).map((p) => p.phoneKey));

  for (const key of keys) {
    const t0 = first.get(key);
    const fresh = !known.has(key);
    if (fresh) isNew += 1;
    const talked = (byKey.get(key) || []).some((c) => connected(c) && Number(c.callTimestampMs) >= t0 && Number(c.callTimestampMs) <= t0 + WEEK_MS);
    if (talked) {
      reached += 1;
      if (fresh) newReached += 1;
    } else {
      lost += 1;
      if (fresh) lostNew += 1;
    }
    const appts = (apptsByKey.get(key) || []).filter((a) => a.createdAt.getTime() >= t0 - 60 * 60 * 1000 && a.createdAt.getTime() <= t0 + MONTH_MS);
    if (appts.length) {
      booked.add(key);
      if (fresh && talked) newBooked += 1;
      if (appts.some((a) => a.status === "attended")) came.add(key);
    }
    if (signedKeys.has(key)) signed.add(key);
  }

  const bookingShare = newReached > 0 ? newBooked / newReached : 0;
  return {
    numbers: keys.length,
    new: isNew,
    returning: keys.length - isNew,
    reached,
    lost,
    lostNew,
    booked: booked.size,
    came: came.size,
    signed: signed.size,
    rates: {
      reached: pct(reached, keys.length),
      booked: pct(booked.size, reached),
      came: pct(came.size, booked.size),
      signed: pct(signed.size, came.size || booked.size),
    },
    fee,
    bookingShare: Math.round(bookingShare * 100),
    expectedLost: Math.round(lostNew * bookingShare * fee),
    lostReasons: await lostReasons(db, employeeIds, from, to),
    now,
  };
}

// Why the period's consultations didn't continue: cases closed as
// "declined" in the period (by their operators, for these phones' people).
async function lostReasons(db, employeeIds, from, to) {
  const fromDate = from != null ? firmDate(new Date(from)) : undefined;
  const toDate = to != null ? firmDate(new Date(to)) : undefined;
  const rows = await db.clientCase.groupBy({
    by: ["lostReason"],
    where: {
      status: "declined",
      ...(employeeIds ? { operatorId: { in: employeeIds } } : {}),
      closedDate: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}), not: null },
    },
    _count: { _all: true },
  });
  return rows.map((r) => ({ reason: r.lostReason || "none", count: r._count._all })).sort((a, b) => b.count - a.count);
}

module.exports = { computeFunnel };
