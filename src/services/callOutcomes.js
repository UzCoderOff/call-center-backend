const prisma = require("../lib/prisma");
const { phoneKey: keyOf } = require("../lib/phone");
const { firmNow, firmDayRange, firmDate, isValidDate, shiftDate } = require("../lib/firmTime");
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
//
// Who the caller belongs to after that (the firm's rule, 2026-10-24):
//   thinking   "Oʻylab koʻradi" (call_again) with the day to talk again: the
//              operator gets a reminder that day, and until two days after
//              it the caller's calls ring that operator first (ownerFor,
//              services/pbx/route.js). Not booked by then: lost.
//   lost       the price, only a question, another firm, something else:
//              after SECOND_DAYS a DIFFERENT operator, the next in turn, gets
//              an «Ikkinchi imkoniyat» task with what happened the first
//              time; from then on the caller rings them first (secondChances).
//   not ours   a wrong number, not the firm's field: nothing more.

const OUTCOMES = ["price", "question", "other_firm", "call_again", "wrong_number", "not_our_field", "other"];
const GROUPS = { thinking: ["call_again"], lost: ["price", "question", "other_firm", "other"], notOurs: ["wrong_number", "not_our_field"] };
const LABELS = {
  price: "Narx qimmat",
  question: "Faqat savol berdi",
  other_firm: "Boshqa joyga ketdi",
  call_again: "Oʻylab koʻradi",
  wrong_number: "Notoʻgʻri raqam",
  not_our_field: "Bizning yoʻnalish emas",
  other: "Boshqa",
};
// A thinking caller stays the operator's this many days past their day.
const THINKING_GRACE_DAYS = 2;
// The furthest "talk again" day an operator can set.
const MAX_FOLLOW_UP_DAYS = 30;
// A second-chance operator stays the caller's first ring this long.
const SECOND_OWN_DAYS = 30;
const SECOND_SETTING = "secondChance";
const SECOND_DEFAULT = { days: 3 };
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

// A "talk again" day: from tomorrow to MAX_FOLLOW_UP_DAYS ahead, or null.
function cleanFollowUp(value, today = firmDate()) {
  if (!isValidDate(value)) return null;
  if (value <= today || value > shiftDate(today, MAX_FOLLOW_UP_DAYS)) return null;
  return value;
}

// Saves (or, with outcome null, takes back) the outcome for a number —
// credited to `employeeId`, the operator who talked to the caller. A thinking
// caller (`followUpOn`) gets that operator a reminder for the day, at 10:00.
async function record({ user, phoneKey, outcome, note, followUpOn = null, phone = null, employeeId = user.employee?.id ?? null, db = prisma }) {
  const existing = await db.callOutcome.findUnique({ where: { phoneKey } });
  // The reminder of an answer being changed, unless it's gone off already.
  if (existing?.reminderId) await db.reminder.deleteMany({ where: { id: existing.reminderId, sentAt: null } });
  if (outcome === null) {
    await db.callOutcome.deleteMany({ where: { phoneKey } });
    return null;
  }
  let reminderId = null;
  const day = outcome === "call_again" ? followUpOn : null;
  if (day && employeeId) {
    const operator = await db.employee.findUnique({ where: { id: employeeId }, select: { userId: true } });
    if (operator?.userId) {
      const f = require("./telegram/format");
      const reminder = await db.reminder.create({
        data: {
          userId: operator.userId,
          createdById: user.id,
          title: `Qayta qoʻngʻiroq: ${f.phone(phone || phoneKey)} — oʻylab koʻrayotgan edi`.slice(0, 200),
          dueAt: new Date(firmDayRange(day).from + 10 * 60 * 60 * 1000),
          phone: phone ? String(phone).slice(0, 40) : phoneKey,
        },
      });
      reminderId = reminder.id;
    }
  }
  const data = { outcome, note: note || null, employeeId, createdById: user.id, followUpOn: day, reminderId };
  return db.callOutcome.upsert({ where: { phoneKey }, create: { phoneKey, ...data }, update: data });
}

// Whose caller this number is now, for its calls to ring them first:
// { employeeId, kind: "second" | "thinking" } or null. Pure: the outcome row.
function ownerOf(row, today = firmDate(), now = Date.now()) {
  if (!row) return null;
  if (row.secondEmployeeId && row.secondAt && now - new Date(row.secondAt).getTime() < SECOND_OWN_DAYS * 24 * 60 * 60 * 1000) {
    return { employeeId: row.secondEmployeeId, kind: "second" };
  }
  if (row.outcome === "call_again" && row.employeeId && row.followUpOn && today <= shiftDate(row.followUpOn, THINKING_GRACE_DAYS)) {
    return { employeeId: row.employeeId, kind: "thinking" };
  }
  return null;
}

async function ownerFor(phoneKey, db = prisma) {
  return ownerOf(await db.callOutcome.findUnique({ where: { phoneKey } }));
}

// Lost now: given up on (GROUPS.lost) SECOND_DAYS ago, or thinking whose day
// passed THINKING_GRACE_DAYS ago. Pure.
function lostSince(row, today = firmDate()) {
  if (GROUPS.lost.includes(row.outcome)) return firmDate(new Date(row.createdAt));
  if (row.outcome === "call_again") return row.followUpOn ? shiftDate(row.followUpOn, THINKING_GRACE_DAYS + 1) : firmDate(new Date(row.createdAt));
  return null;
}

// The next operator in turn after `lastId` (ids in order, around), not the
// one who had the caller first. Pure.
function nextInTurn(ids, lastId, notId) {
  const sorted = [...ids].sort((a, b) => a - b).filter((id) => id !== notId);
  if (!sorted.length) return null;
  return sorted.find((id) => id > (lastId ?? 0)) ?? sorted[0];
}

// Lost callers whose second chance is due -> the next operator in turn, as a
// task. Only callers recorded since this first ran (no backlog), at most a
// few at a time, in working hours.
async function secondChances({ now = new Date(), db = prisma } = {}) {
  const firm = firmNow(now);
  if (firm.minutes < 9 * 60 || firm.minutes > 17 * 60) return 0;
  const settings = { ...SECOND_DEFAULT, ...(await getSetting(SECOND_SETTING, {}, db)) };
  if (!Number.isFinite(settings.since)) {
    await setSetting(SECOND_SETTING, { ...settings, since: now.getTime() }, null, db);
    return 0;
  }
  const today = firm.date;
  const rows = await db.callOutcome.findMany({
    where: { secondAt: null, outcome: { in: [...GROUPS.lost, ...GROUPS.thinking] }, createdAt: { gte: new Date(settings.since) } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const due = rows.filter((r) => {
    const since = lostSince(r, today);
    return since && shiftDate(since, settings.days) <= today;
  });
  if (!due.length) return 0;
  const operators = await db.employee.findMany({ where: { active: true, userId: { not: null }, ...jobWhere(["call_center"]) }, select: { id: true, userId: true, name: true, job: true, extraJobs: true } });
  const pool = operators.filter(isCallCenter);
  const byId = new Map(pool.map((e) => [e.id, e]));
  let lastId = settings.lastId ?? null;
  let given = 0;
  for (const row of due.slice(0, 10)) {
    if (await bookedSince(row, db)) {
      // Booked after all: nothing to chase.
      await db.callOutcome.update({ where: { id: row.id }, data: { secondAt: now } });
      continue;
    }
    const nextId = nextInTurn([...byId.keys()], lastId, row.employeeId);
    if (!nextId) break; // one operator only: nobody to give it to
    const operator = byId.get(nextId);
    const task = await db.task.create({ data: await secondChanceTask(row, operator, now, db) });
    await db.callOutcome.update({ where: { id: row.id }, data: { secondEmployeeId: operator.id, secondAt: now, secondTaskId: task.id } });
    require("../lib/events").events.emit("task.created", { taskId: task.id });
    lastId = nextId;
    given += 1;
  }
  await setSetting(SECOND_SETTING, { ...settings, lastId }, null, db);
  return given;
}

// Booked since the outcome was recorded: by the number, or for its client.
async function bookedSince(row, db) {
  const since = new Date(row.createdAt.getTime() - 60 * 60 * 1000);
  if (await db.appointment.count({ where: { phoneKey: row.phoneKey, status: { not: "cancelled" }, createdAt: { gte: since } } })) return true;
  const phones = await db.clientPhone.findMany({ where: { phoneKey: row.phoneKey }, select: { clientId: true } });
  if (!phones.length) return false;
  return (await db.appointment.count({ where: { clientId: { in: phones.map((p) => p.clientId) }, status: { not: "cancelled" }, createdAt: { gte: since } } })) > 0;
}

// The task: who talked to them first and when, why it didn't work out, what
// the AI review of that call said — and to come with a new offer.
async function secondChanceTask(row, operator, now, db) {
  const f = require("./telegram/format");
  const call = await db.callLog.findFirst({
    where: { phoneKey: row.phoneKey, missed: false, durationSeconds: { gt: 0 } },
    orderBy: { callTimestampMs: "desc" },
    select: { id: true, phoneNumber: true, callTimestampMs: true, employee: { select: { name: true } }, analysis: { select: { summary: true, status: true } } },
  });
  const first = call?.employee?.name || (row.employeeId ? (await db.employee.findUnique({ where: { id: row.employeeId }, select: { name: true } }))?.name : null);
  const why = row.outcome === "call_again" ? "Oʻylab koʻrishini aytgan, lekin yozilmadi" : LABELS[row.outcome];
  const notes = [
    first ? `Birinchi boʻlib ${first} gaplashgan${call ? ` (${f.moment(new Date(Number(call.callTimestampMs)))})` : ""}.` : null,
    `Natija: ${why}${row.note ? ` — ${row.note}` : ""}.`,
    call?.analysis?.status === "done" && call.analysis.summary ? `Qoʻngʻiroq haqida (AI): ${call.analysis.summary}` : null,
    "Yangi taklif bilan qoʻngʻiroq qiling (Material 1 jadvali). Qanday boʻlganini javobga yozing.",
    call ? `Birinchi qoʻngʻiroq: ${require("../config/env").portalUrl || ""}/calls/${call.id}` : null,
  ].filter(Boolean);
  const today = firmDate(now);
  const due = firmNow(now).minutes < 15 * 60 ? today : shiftDate(today, 1);
  return {
    title: `Ikkinchi imkoniyat: ${f.phone(call?.phoneNumber || row.phoneKey)}`.slice(0, 200),
    notes: notes.join("\n").slice(0, 2000),
    assigneeId: operator.userId,
    createdById: null,
    dueAt: new Date(firmDayRange(due).from + 18 * 60 * 60 * 1000),
    needsAnswer: true,
  };
}

// When each number (or its client) booked a consultation after `fromMs`:
// phoneKey -> [epoch ms of bookings], for many outcome rows at once.
async function bookingsAfter(keys, fromMs, db = prisma) {
  const out = new Map(keys.map((k) => [k, []]));
  if (!keys.length) return out;
  const since = new Date(fromMs - 60 * 60 * 1000);
  const phones = await db.clientPhone.findMany({ where: { phoneKey: { in: keys } }, select: { phoneKey: true, clientId: true } });
  const clientIds = [...new Set(phones.map((p) => p.clientId))];
  const bookings = await db.appointment.findMany({
    where: { status: { not: "cancelled" }, createdAt: { gte: since }, OR: [{ phoneKey: { in: keys } }, ...(clientIds.length ? [{ clientId: { in: clientIds } }] : [])] },
    select: { phoneKey: true, clientId: true, createdAt: true },
  });
  for (const b of bookings) {
    const ks = new Set([b.phoneKey, ...phones.filter((p) => p.clientId === b.clientId).map((p) => p.phoneKey)].filter((k) => out.has(k)));
    for (const k of ks) out.get(k).push(b.createdAt.getTime());
  }
  return out;
}

// What came of the retries, per operator, for outcomes recorded (thinking,
// lost) or second chances given in [fromMs, toMs]: Map employeeId -> {
//   thinking:   { total, booked }   their callers who said they'd think
//   lost:       { total }           their callers lost (price, other firm…)
//   secondGot:  { total, booked }   lost callers handed to them, booked since
//   secondOut:  { total, booked }   their lost callers handed to someone else
// }. Booked: a consultation for the number (or its client) after the answer
// (for a second chance: after it was handed over).
async function retryResults(employeeIds, { fromMs, toMs }, db = prisma) {
  const range = { gte: new Date(fromMs), lte: new Date(toMs) };
  const rows = await db.callOutcome.findMany({
    where: { OR: [{ employeeId: { in: employeeIds }, createdAt: range }, { secondEmployeeId: { in: employeeIds }, secondAt: range }] },
    select: { phoneKey: true, outcome: true, employeeId: true, createdAt: true, secondEmployeeId: true, secondAt: true },
  });
  const blank = () => ({ thinking: { total: 0, booked: 0 }, lost: { total: 0 }, secondGot: { total: 0, booked: 0 }, secondOut: { total: 0, booked: 0 } });
  const out = new Map(employeeIds.map((id) => [id, blank()]));
  if (!rows.length) return out;
  const booked = await bookingsAfter([...new Set(rows.map((r) => r.phoneKey))], Math.min(...rows.map((r) => r.createdAt.getTime())), db);
  const after = (key, ms) => (booked.get(key) || []).some((t) => t >= ms - 60 * 60 * 1000);
  for (const r of rows) {
    const created = r.createdAt.getTime();
    const mine = out.get(r.employeeId);
    if (mine && created >= fromMs && created <= toMs) {
      if (GROUPS.thinking.includes(r.outcome)) {
        mine.thinking.total += 1;
        if (after(r.phoneKey, created)) mine.thinking.booked += 1;
      } else if (GROUPS.lost.includes(r.outcome)) mine.lost.total += 1;
    }
    if (r.secondEmployeeId && r.secondAt) {
      const at = r.secondAt.getTime();
      if (at < fromMs || at > toMs) continue;
      const won = after(r.phoneKey, at);
      const got = out.get(r.secondEmployeeId);
      if (got) {
        got.secondGot.total += 1;
        if (won) got.secondGot.booked += 1;
      }
      if (mine && r.secondEmployeeId !== r.employeeId) {
        mine.secondOut.total += 1;
        if (won) mine.secondOut.booked += 1;
      }
    }
  }
  return out;
}

module.exports = {
  bookingsAfter,
  retryResults,
  OUTCOMES,
  GROUPS,
  LABELS,
  askedSince,
  pending,
  record,
  callCenterIds,
  cleanFollowUp,
  ownerOf,
  ownerFor,
  lostSince,
  nextInTurn,
  secondChances,
  WINDOW_MS,
  THINKING_GRACE_DAYS,
};
