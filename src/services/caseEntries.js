const cl = require("./clients");
const { isValidDate, shiftDate } = require("../lib/firmTime");

// A history entry with a type (2026-10-15) — what happened in a case, with
// the few details that kind of event has, instead of one empty box. Stored
// as a note (ClientEvent kind "note", the words in `text`) with
// data: { type, on, ... }. Older notes have no type and stay as they were.
//
//   hearing   a hearing (or questioning…) took place: how it went, the next one
//   filed     a document handed in: what, where
//   decision  a decision received: in whose favour; the deadline it starts
//   meeting   met the client (or someone for them): who
//   call      talked on the phone outside Ledger: with whom
//   other     anything else
//
// `next` (a hearing's next date) and `deadline` (a decision's) also become
// key dates of the case — the route adds them (routes/clients.js).

const ENTRY_TYPES = ["hearing", "filed", "decision", "meeting", "call", "other"];
// Need a case (they're about the case's road).
const CASE_TYPES = ["hearing", "filed", "decision"];
// How a hearing went.
const HEARING_RESULTS = ["postponed", "heard", "decided", "not_held", "other"];
// In whose favour a decision went.
const DECISION_RESULTS = ["won", "partly", "lost", "other"];

class EntryError extends Error {}
const bad = (msg) => new EntryError(msg);

function day(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const d = String(value);
  if (!isValidDate(d)) throw bad(`invalid ${field}`);
  return d;
}

function minutes(value) {
  if (value === undefined || value === null || value === "") return null;
  const m = Number(value);
  if (!Number.isInteger(m) || m < 0 || m >= 24 * 60) throw bad("invalid time");
  return m;
}

// A key date this entry sets: { date, time?, place?, title? } -> the fields
// to store, or null. `after`: it must not be before this day.
function keyDate(input, { after, field }) {
  if (!input || typeof input !== "object") return null;
  const date = day(input.date, field);
  if (!date) return null;
  if (after && date < after) throw bad(`${field} is before the entry`);
  return { date, time: minutes(input.time), place: cl.text(input.place, 200) ?? null, title: cl.text(input.title, 200) ?? null };
}

// A request -> { text, data, next, deadline } (next/deadline: key dates to
// add, or null). `today`: "YYYY-MM-DD" (firm time).
function normalizeEntry(body, today) {
  const b = body || {};
  const type = ENTRY_TYPES.includes(b.type) ? b.type : null;
  if (!type) throw bad("invalid type");
  const text = cl.text(b.text, 4000) || "";
  // A hearing's or a decision's result can be the whole entry.
  const resultOnly = (type === "hearing" || type === "decision") && Boolean(b.result);
  if (!text && !resultOnly) throw bad("text is required");
  const on = day(b.on, "on") || today;
  if (on > shiftDate(today, 1)) throw bad("on is in the future");
  const data = { type, on };
  if (type === "hearing") {
    if (b.result !== undefined && b.result !== null && !HEARING_RESULTS.includes(b.result)) throw bad("invalid result");
    if (b.result) data.result = b.result;
    const place = cl.text(b.place, 200);
    if (place) data.place = place;
  }
  if (type === "filed") {
    const what = cl.text(b.what, 200);
    if (what) data.what = what;
    const place = cl.text(b.place, 200);
    if (place) data.place = place;
  }
  if (type === "decision") {
    if (b.result !== undefined && b.result !== null && !DECISION_RESULTS.includes(b.result)) throw bad("invalid result");
    if (b.result) data.result = b.result;
  }
  if (type === "meeting" || type === "call") {
    const who = cl.text(b.with, 200);
    if (who) data.with = who;
  }
  if (b.fileId !== undefined && b.fileId !== null && b.fileId !== "") {
    const fileId = Number(b.fileId);
    if (!Number.isInteger(fileId) || fileId <= 0) throw bad("invalid fileId");
    data.fileId = fileId;
  }
  const next = type === "hearing" ? keyDate(b.next, { after: on, field: "next" }) : null;
  const deadline = type === "decision" ? keyDate(b.deadline, { after: on, field: "deadline" }) : null;
  if (deadline && !deadline.title) throw bad("deadline title is required");
  return { type, text, data, next, deadline };
}

// The deadline a decision starts: its date + the firm's number of days for
// the stage the case is at (Setting "deadlineDays": { stage: days }), or
// null when none is saved. Nothing is assumed — the lawyers set the days.
function suggestDeadline(decisionDate, stage, days) {
  const n = Number(days?.[stage || "_"]);
  if (!isValidDate(decisionDate) || !Number.isInteger(n) || n <= 0 || n > 3650) return null;
  return shiftDate(decisionDate, n);
}

// Adds a key date to a case inside a transaction, with its line on the
// timeline — as routes/caseWork.js does. `kase`: { id, clientId }.
async function addKeyDate(tx, { kase, userId, kind, date, time = null, place = null, title = null, note = null }) {
  const created = await tx.caseDate.create({ data: { caseId: kase.id, kind, date, time, place, title, note, createdById: userId } });
  await tx.clientEvent.create({ data: { clientId: kase.clientId, caseId: kase.id, kind: "date_row", text: "", data: { action: "add", kind, date, time, title }, authorId: userId } });
  return created;
}

module.exports = { addKeyDate, ENTRY_TYPES, CASE_TYPES, HEARING_RESULTS, DECISION_RESULTS, EntryError, normalizeEntry, suggestDeadline };
