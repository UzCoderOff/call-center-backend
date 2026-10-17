const prisma = require("../lib/prisma");
const { getSetting, setSetting } = require("../lib/settings");
const { firmNow, firmDayRange } = require("../lib/firmTime");
const { events } = require("../lib/events");
const cl = require("./clients");
const { syncNextCall } = require("./clientFollowUps");

// "Suhbat yakuni" — the consultation summary (the boss, 2026-10-14): after a
// consultation, the specialist who held it (the calendar's owner) writes
// what it was about, what they advised and how it ended — and whether the
// client is a potential one:
//
//   potential      and what happens next:
//                    contract  they signed (or agreed to): the case is a
//                              contract now
//                    decision  they're thinking it over — talking to their
//                              family about the money, say: on that day the
//                              operator who brought them asks again
//                    call      call them back on that day
//                    meeting   they come in again on that day
//                  The step goes to the operator who brought the client (a
//                  ClientFollowUp — their home, Telegram and the app remind
//                  them when it's due).
//   not_potential  why (the lost reasons): the case "didn't continue".
//
// The specialist is reminded (Telegram, the app) half an hour after the
// consultation and in the evening; with the firm's rule switched on
// (Setting "summaryRule"), a summary not written in time is a strike.

const PROSPECTS = ["potential", "not_potential"];
const NEXT_KINDS = ["contract", "decision", "call", "meeting"];
const NEEDS_DATE = ["decision", "call", "meeting"];
// What still needs a summary: consultations that happened (or should have —
// nobody marked them).
const OPEN_STATUSES = ["booked", "attended"];
const DAY_MS = 24 * 60 * 60 * 1000;

const RULE_DEFAULTS = {
  // Strikes for summaries not written in time.
  enabled: false,
  // Written within this many hours of the consultation's end; null: by the
  // end of that day.
  hours: null,
  // Strikes a month before the managers hear about it.
  limit: 3,
  // When the strikes started counting (switching on again starts afresh).
  since: null,
  // The first day the "not written" lists and reminders look at — the day
  // this was released, so older consultations don't all ask at once.
  listFrom: null,
};

class SummaryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function summaryRule(db = prisma) {
  const rule = await getSetting("summaryRule", RULE_DEFAULTS, db);
  if (!rule.listFrom) {
    const next = { ...rule, listFrom: firmNow().date };
    await setSetting("summaryRule", next, null, db);
    return next;
  }
  return rule;
}

// The rule as sent from the portal (managers), checked. Switching it on
// (again) starts counting from now.
function normalizeRule(input, current, now = new Date()) {
  const b = input || {};
  const next = { ...RULE_DEFAULTS, ...current };
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") throw new SummaryError("invalid enabled");
    if (b.enabled && !next.enabled) next.since = now.toISOString();
    next.enabled = b.enabled;
  }
  if (b.hours !== undefined) {
    if (b.hours === null || b.hours === "") next.hours = null;
    else {
      const h = Number(b.hours);
      if (!Number.isInteger(h) || h < 1 || h > 72) throw new SummaryError("invalid hours");
      next.hours = h;
    }
  }
  if (b.limit !== undefined) {
    const n = Number(b.limit);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new SummaryError("invalid limit");
    next.limit = n;
  }
  return next;
}

// A summary as typed. `nowMs` checks the next step's date (not in the past,
// not more than a year ahead).
function normalizeSummary(input, nowMs = Date.now()) {
  const b = input || {};
  const topic = cl.text(b.topic, 2000) ?? null;
  const advice = cl.text(b.advice, 4000) ?? null;
  const conclusion = cl.text(b.conclusion, 4000) ?? null;
  if (!conclusion) throw new SummaryError("conclusion is required");
  if (!PROSPECTS.includes(b.prospect)) throw new SummaryError("invalid prospect");
  const out = { topic, advice, conclusion, prospect: b.prospect, next: null, lostReason: null, lostNote: null };
  if (b.prospect === "potential") {
    const n = b.next || {};
    if (!NEXT_KINDS.includes(n.kind)) throw new SummaryError("invalid next step");
    const next = { kind: n.kind, dueAt: null, note: cl.text(n.note, 500) ?? null, contactId: n.contactId == null || n.contactId === "" ? null : Number(n.contactId) };
    if (next.contactId != null && !Number.isInteger(next.contactId)) throw new SummaryError("invalid contactId");
    if (NEEDS_DATE.includes(n.kind)) {
      const due = new Date(n.dueAt);
      if (n.dueAt == null || n.dueAt === "" || Number.isNaN(due.getTime())) throw new SummaryError("next step date is required");
      if (due.getTime() < nowMs - DAY_MS) throw new SummaryError("next step date is in the past");
      if (due.getTime() > nowMs + 366 * DAY_MS) throw new SummaryError("next step date is too far ahead");
      next.dueAt = due.toISOString();
    }
    out.next = next;
  } else {
    if (!cl.LOST_REASONS.includes(b.lostReason)) throw new SummaryError("lost reason required");
    out.lostReason = b.lostReason;
    out.lostNote = cl.text(b.lostNote, 500) ?? null;
  }
  return out;
}

// Texts corrected afterwards (what it was about, the advice, the
// conclusion) — the outcome itself isn't changed this way.
function normalizeTextChange(input, current) {
  const b = input || {};
  const out = { ...current };
  for (const [key, max] of [
    ["topic", 2000],
    ["advice", 4000],
    ["conclusion", 4000],
  ]) {
    const v = cl.text(b[key], max);
    if (v !== undefined) out[key] = v;
  }
  if (!out.conclusion) throw new SummaryError("conclusion is required");
  return out;
}

// Whether a consultation is over (by the firm's clock): `now` = firmNow().
const isOver = (a, now) => a.date < now.date || (a.date === now.date && a.end <= now.minutes);

// It needs a summary: it happened (attended, or still "booked" but over —
// nobody marked it), and none is written.
const needsSummary = (a, now) => !a.summaryAt && OPEN_STATUSES.includes(a.status) && (a.status === "attended" || isOver(a, now));

// The moment the summary is due: so many hours after the end, or the end of
// that day.
function deadlineFor(a, rule) {
  const range = firmDayRange(a.date);
  if (rule?.hours) {
    // A walk-in written down later: from when it was entered, not from a
    // time that had already passed.
    const ended = range.from + a.end * 60 * 1000;
    const from = a.walkIn && a.createdAt ? Math.max(ended, new Date(a.createdAt).getTime()) : ended;
    return new Date(from + rule.hours * 60 * 60 * 1000);
  }
  return new Date(range.to);
}

// Prisma: consultations still waiting for a summary (from `listFrom` on).
function missingWhere(rule, now) {
  return {
    summaryAt: null,
    status: { in: OPEN_STATUSES },
    date: { gte: rule.listFrom || now.date, lte: now.date },
    calendar: { active: true },
    OR: [{ status: "attended" }, { date: { lt: now.date } }, { date: now.date, end: { lte: now.minutes } }],
  };
}

// Who may write it: the specialist who held it (the calendar's owner), the
// boss and the developer.
function mayWrite(user, appointment) {
  return appointment.calendar?.ownerId === user.id || user.role === "BOSS" || user.role === "DEVELOPER";
}

// The case the consultation was about: its own, the one asked for, or the
// client's open consultation (else their latest case).
const WITH_OPERATOR = { operator: { select: { userId: true, name: true } } };
async function caseFor(tx, appointment, requestedCaseId) {
  if (!appointment.clientId) return null;
  const id = requestedCaseId ?? appointment.caseId;
  if (id != null) {
    const k = await tx.clientCase.findFirst({ where: { id: Number(id), clientId: appointment.clientId }, include: WITH_OPERATOR });
    if (!k) throw new SummaryError("case is not this client's");
    return k;
  }
  const open = await tx.clientCase.findFirst({ where: { clientId: appointment.clientId, status: { in: ["consultation", "call_again"] } }, orderBy: { updatedAt: "desc" }, include: WITH_OPERATOR });
  return open || tx.clientCase.findFirst({ where: { clientId: appointment.clientId }, orderBy: { updatedAt: "desc" }, include: WITH_OPERATOR });
}

const FOLLOW_UP_KIND = { decision: "decision", call: "call", meeting: "meeting" };
const NEXT_WORDS = { contract: "shartnoma tuzildi", decision: "oʻylab koʻradi", call: "qayta qoʻngʻiroq", meeting: "yana uchrashuv" };

// Saves the summary and does what it says. -> { appointment, followUpId, caseId }
async function saveSummary(db, { appointmentId, user, input, caseId: requestedCaseId }) {
  const today = firmNow().date;
  const summary = normalizeSummary(input);
  const result = await db.$transaction(async (tx) => {
    const a = await tx.appointment.findUnique({ where: { id: appointmentId }, include: { calendar: true } });
    if (!a) throw new SummaryError("not_found", 404);
    if (!mayWrite(user, a)) throw new SummaryError("forbidden", 403);
    if (a.status === "cancelled") throw new SummaryError("cancelled", 409);
    if (a.status === "no_show") throw new SummaryError("no_show", 409);
    if (a.summaryAt) throw new SummaryError("already_written", 409);
    const kase = await caseFor(tx, a, requestedCaseId);
    if (summary.next?.contactId != null) {
      const c = await tx.clientContact.findFirst({ where: { id: summary.next.contactId, clientId: a.clientId ?? -1, deletedAt: null }, select: { id: true } });
      if (!c) throw new SummaryError("contact is not this client's");
    }
    const stored = { ...summary, operator: kase?.operator?.name ?? null };
    const updated = await tx.appointment.update({
      where: { id: a.id },
      data: { summary: stored, summaryAt: new Date(), summaryById: user.id, caseId: kase?.id ?? null, ...(a.status === "booked" ? { status: "attended" } : {}) },
    });
    await tx.summaryStrike.updateMany({ where: { appointmentId: a.id, writtenAt: null }, data: { writtenAt: new Date() } });
    let followUpId = null;
    let contract = false;
    if (a.clientId) {
      const log = (kind, text, data) => tx.clientEvent.create({ data: { clientId: a.clientId, caseId: kase?.id ?? null, kind, text: text ?? "", data, authorId: user.id } });
      await log("consult_summary", summary.conclusion, {
        appointmentId: a.id,
        date: a.date,
        prospect: summary.prospect,
        next: summary.next ? { kind: summary.next.kind, dueAt: summary.next.dueAt } : null,
        lostReason: summary.lostReason,
      });
      if (kase && summary.prospect === "potential" && summary.next.kind === "contract" && ["consultation", "call_again"].includes(kase.status)) {
        await tx.clientCase.update({ where: { id: kase.id }, data: { status: "contract", contractDate: kase.contractDate ?? today, ...(kase.consultationDate ? {} : { consultationDate: a.date }) } });
        await log("status", `${kase.status}>contract`);
        contract = true;
      }
      if (summary.prospect === "potential" && FOLLOW_UP_KIND[summary.next.kind]) {
        // The operator who brought the client asks again — or whoever
        // booked it, when that wasn't the specialist themselves.
        const assigneeId = kase?.operator?.userId ?? (a.bookedById !== a.calendar.ownerId ? a.bookedById : null);
        const note = summary.next.note || `${NEXT_WORDS[summary.next.kind]} — ${summary.conclusion}`.slice(0, 500);
        const row = await tx.clientFollowUp.create({
          data: {
            clientId: a.clientId,
            caseId: kase?.id ?? null,
            contactId: summary.next.contactId,
            kind: FOLLOW_UP_KIND[summary.next.kind],
            dueAt: new Date(summary.next.dueAt),
            note,
            assigneeId,
            createdById: user.id,
          },
        });
        followUpId = row.id;
        await log("follow_up", "", { action: "add", kind: row.kind, dueAt: row.dueAt, note: row.note });
        await syncNextCall(tx, a.clientId);
      }
      if (kase && summary.prospect === "not_potential" && kase.status !== "declined" && !["contract", "done"].includes(kase.status)) {
        await tx.clientCase.update({ where: { id: kase.id }, data: { status: "declined", lostReason: summary.lostReason, lostNote: summary.lostNote, closedDate: kase.closedDate ?? today } });
        await log("status", `${kase.status}>declined`);
        await log("lost", "", { reason: summary.lostReason, note: summary.lostNote });
      }
      await tx.client.update({ where: { id: a.clientId }, data: { updatedAt: new Date() } });
    }
    return { appointment: updated, followUpId, caseId: kase?.id ?? null, contract };
  });
  events.emit("consultation.summary", { appointmentId, followUpId: result.followUpId, byUserId: user.id });
  if (result.contract) events.emit("case.contract", { caseId: result.caseId, byUserId: user.id });
  return result;
}

async function updateSummaryText(db, { appointmentId, user, input }) {
  const a = await db.appointment.findUnique({ where: { id: appointmentId }, include: { calendar: true } });
  if (!a) throw new SummaryError("not_found", 404);
  if (!a.summaryAt) throw new SummaryError("not_written", 409);
  if (!(a.summaryById === user.id || user.role === "BOSS" || user.role === "DEVELOPER")) throw new SummaryError("forbidden", 403);
  const summary = normalizeTextChange(input, a.summary || {});
  return db.$transaction(async (tx) => {
    const u = await tx.appointment.update({ where: { id: a.id }, data: { summary } });
    await tx.auditLog.create({ data: { userId: user.id, action: "summary.edit", entity: "appointment", entityId: a.id, detail: { clientId: a.clientId, before: a.summary, after: summary } } });
    return u;
  });
}

// ------------------------------------------------------------ strikes
// Every few minutes (services/scheduler.js), with the rule on: each
// consultation since the rule was switched on whose summary wasn't written
// by its deadline gets a strike for its specialist (once). Written late:
// the strike stays, with when.
async function evaluateSummaryStrikes(db = prisma, nowDate = new Date()) {
  const rule = await summaryRule(db);
  if (!rule.enabled || !rule.since) return { created: 0 };
  const now = firmNow(nowDate);
  const sinceDate = firmNow(new Date(rule.since)).date;
  const rows = await db.appointment.findMany({
    where: { status: { in: OPEN_STATUSES }, date: { gte: sinceDate, lte: now.date }, summaryStrike: null, calendar: { active: true } },
    select: { id: true, date: true, start: true, end: true, status: true, walkIn: true, summaryAt: true, createdAt: true, calendar: { select: { ownerId: true } } },
  });
  let created = 0;
  for (const a of rows) {
    if (a.status === "booked" && !isOver(a, firmNow(nowDate))) continue;
    // Only consultations that started after the rule was switched on.
    if (firmDayRange(a.date).from + a.start * 60 * 1000 < new Date(rule.since).getTime()) continue;
    const deadline = deadlineFor(a, rule);
    if (deadline.getTime() > nowDate.getTime()) continue;
    if (a.summaryAt && a.summaryAt.getTime() <= deadline.getTime()) continue;
    const strike = await db.summaryStrike
      .create({ data: { userId: a.calendar.ownerId, appointmentId: a.id, month: a.date.slice(0, 7), deadlineAt: deadline, writtenAt: a.summaryAt } })
      .catch((err) => (err.code === "P2002" ? null : Promise.reject(err)));
    if (strike) {
      created += 1;
      events.emit("summary.strike", { strikeId: strike.id });
    }
  }
  return { created };
}

// { userId: count } of strikes not cancelled in a month.
async function summaryStrikeCounts(month, db = prisma) {
  const rows = await db.summaryStrike.groupBy({ by: ["userId"], where: { month, cancelledAt: null }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.userId, r._count._all]));
}

module.exports = {
  PROSPECTS,
  NEXT_KINDS,
  RULE_DEFAULTS,
  SummaryError,
  summaryRule,
  normalizeRule,
  normalizeSummary,
  normalizeTextChange,
  needsSummary,
  isOver,
  deadlineFor,
  missingWhere,
  mayWrite,
  saveSummary,
  updateSummaryText,
  evaluateSummaryStrikes,
  summaryStrikeCounts,
};
