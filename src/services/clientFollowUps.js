const cl = require("./clients");
const { phoneKey } = require("../lib/phone");

// Connected people and "what happens next" for a client, as pure rules
// (tested in test/clientFollowUps.test.js). Not to be confused with
// services/followUp.js — whether a missed call was called back.
//
// Contacts: someone connected to the client (father, wife, a
// representative…) the firm talks to, often the one who decides or pays.
//
// Follow-ups: what has to happen next with the client, by when, by whom —
//   call       call them back
//   decision   they're thinking it over: when the time is up, call whoever
//              decides (the client, or a contact — "call the father")
//   meeting    a meeting is due
//   documents  papers to bring or send
//   payment    a payment to collect
//   other
// Done with what came of it (reached, no answer, decided yes / no,
// rescheduled), or cancelled. The earliest open one is the client's "next
// call" (Client.nextCallAt), which lists and the morning summary use.

const RELATIONS = ["father", "mother", "spouse", "child", "sibling", "relative", "representative", "friend", "colleague", "other"];
const FOLLOW_UP_KINDS = ["call", "decision", "meeting", "documents", "payment", "other"];
const OUTCOMES = ["reached", "no_answer", "decided_yes", "decided_no", "rescheduled", "other"];
const STATUSES = ["open", "done", "cancelled"];
const { LOST_REASONS } = cl;

// A follow-up can be put this far ahead at most (a typo in the year).
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

function normalizeContact(input, current = {}) {
  const b = input || {};
  const data = {};
  if (b.name !== undefined || !current.id) {
    const name = cl.text(b.name, 160);
    if (!name) throw new cl.ClientError("name is required");
    data.name = name;
  }
  if (b.relation !== undefined || !current.id) {
    if (!RELATIONS.includes(b.relation)) throw new cl.ClientError("invalid relation");
    data.relation = b.relation;
  }
  if (b.phone !== undefined) {
    const phone = cl.text(b.phone, 40);
    data.phone = phone;
    data.phoneKey = phone ? phoneKey(phone) : null;
  }
  const note = cl.text(b.note, 1000);
  if (note !== undefined) data.note = note;
  if (b.decides !== undefined) {
    if (typeof b.decides !== "boolean") throw new cl.ClientError("decides must be true or false");
    data.decides = b.decides;
  }
  return data;
}

function when(value, now) {
  const d = new Date(value);
  if (value == null || value === "" || Number.isNaN(d.getTime())) throw new cl.ClientError("invalid dueAt");
  if (d.getTime() > now + MAX_AHEAD_MS) throw new cl.ClientError("dueAt is too far ahead");
  return d;
}

// A new follow-up, or a change to one (`current`). `now` in ms.
function normalizeFollowUp(input, current = {}, now = Date.now()) {
  const b = input || {};
  const data = {};
  if (b.kind !== undefined || !current.id) {
    if (!FOLLOW_UP_KINDS.includes(b.kind)) throw new cl.ClientError("invalid kind");
    data.kind = b.kind;
  }
  if (b.dueAt !== undefined || !current.id) data.dueAt = when(b.dueAt, now);
  const note = cl.text(b.note, 1000);
  if (note !== undefined) data.note = note;
  return data;
}

// Closing one: done (with what came of it) or cancelled.
function normalizeClose(input) {
  const b = input || {};
  if (!["done", "cancelled"].includes(b.status)) throw new cl.ClientError("invalid status");
  const data = { status: b.status };
  if (b.status === "done") {
    if (b.outcome !== undefined && b.outcome !== null && !OUTCOMES.includes(b.outcome)) throw new cl.ClientError("invalid outcome");
    data.outcome = b.outcome ?? null;
  }
  const note = cl.text(b.outcomeNote, 1000);
  if (note !== undefined) data.outcomeNote = note;
  return data;
}

// The client's "next call": the earliest open follow-up (or none).
function nextCallOf(followUps) {
  const open = (followUps || []).filter((f) => f.status === "open");
  if (open.length === 0) return { nextCallAt: null, nextCallNote: null };
  const first = open.reduce((a, b) => (new Date(b.dueAt) < new Date(a.dueAt) ? b : a));
  return { nextCallAt: new Date(first.dueAt), nextCallNote: first.note ?? null };
}

// Keeps Client.nextCallAt / nextCallNote equal to the earliest open
// follow-up. Inside the transaction that changed them.
async function syncNextCall(tx, clientId) {
  const open = await tx.clientFollowUp.findMany({ where: { clientId, status: "open" }, select: { dueAt: true, note: true, status: true } });
  return tx.client.update({ where: { id: clientId }, data: nextCallOf(open) });
}

// What a follow-up is shown with (the client page, the home list).
const PERSON = { select: { id: true, username: true, name: true, employee: { select: { name: true } } } };
const FOLLOW_UP_INCLUDE = {
  contact: { select: { id: true, name: true, relation: true, phone: true } },
  assignee: PERSON,
  createdBy: PERSON,
  doneBy: PERSON,
  case: { select: { id: true, matter: true } },
  client: { select: { id: true, name: true, phones: { select: { phone: true }, orderBy: { id: "asc" }, take: 1 } } },
};

module.exports = {
  FOLLOW_UP_INCLUDE,
  RELATIONS,
  FOLLOW_UP_KINDS,
  OUTCOMES,
  STATUSES,
  LOST_REASONS,
  normalizeContact,
  normalizeFollowUp,
  normalizeClose,
  nextCallOf,
  syncNextCall,
};
