const { isValidDate } = require("../lib/firmTime");
const cl = require("./clients");

// A case's history, beyond notes (tested in test/caseHistory.test.js):
//
//   stages  where the case has been and since when — one row per stage it
//           reached ("tergov 2026-03-12", "birinchi instansiya 2026-06-01").
//           Rows can carry past dates (a case brought in from before
//           Ledger), be corrected, or be removed (kept, hidden). The case's
//           legalStage is always the latest row (by date, then by entry).
//   dates   the dates that matter: hearings, summons, deadlines, meetings —
//           and, once past, what happened.
//
// Every change also goes into the client's timeline (ClientEvent, with its
// details in `data`) and, for corrections and removals, the audit log.

class HistoryError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function date(value, field, { notAfter } = {}) {
  if (value === undefined) return undefined;
  if (!isValidDate(value)) throw new HistoryError(`invalid ${field}`);
  // A stage can't be reached in the future (a typo in the year, usually).
  if (notAfter && value > notAfter) throw new HistoryError(`${field} is in the future`);
  return value;
}

// A stage row as typed; `current`: the row being corrected ({} for a new one).
function normalizeStage(input, current = {}, today) {
  const b = input || {};
  const data = {};
  if (b.stage !== undefined || !current.id) {
    if (!cl.LEGAL_STAGES.includes(b.stage)) throw new HistoryError("invalid stage");
    data.stage = b.stage;
  }
  const day = date(b.date, "date", { notAfter: today });
  if (day !== undefined) data.date = day;
  else if (!current.id) data.date = today;
  const court = cl.text(b.court, 200);
  if (court !== undefined) data.court = court;
  const note = cl.text(b.note, 2000);
  if (note !== undefined) data.note = note;
  return data;
}

// The latest stage of these rows (removed ones don't count): by date, then
// by the order they were entered. null when there are none.
function latestStage(rows) {
  const live = (rows || []).filter((r) => !r.deletedAt);
  if (live.length === 0) return null;
  return live.reduce((best, r) => (r.date > best.date || (r.date === best.date && r.id > best.id) ? r : best));
}

// A key date as typed; `current`: the one being changed ({} for a new one).
function normalizeKeyDate(input, current = {}) {
  const b = input || {};
  const data = {};
  if (b.kind !== undefined || !current.id) {
    if (!cl.DATE_KINDS.includes(b.kind)) throw new HistoryError("invalid kind");
    data.kind = b.kind;
  }
  if (b.date !== undefined || !current.id) {
    if (!isValidDate(b.date)) throw new HistoryError("invalid date");
    data.date = b.date;
  }
  if (b.time !== undefined) {
    if (b.time === null || b.time === "") data.time = null;
    else {
      const t = Number(b.time);
      if (!Number.isInteger(t) || t < 0 || t > 1439) throw new HistoryError("invalid time");
      data.time = t;
    }
  }
  for (const [key, max] of [
    ["title", 200],
    ["place", 200],
    ["note", 2000],
    ["outcome", 2000],
  ]) {
    const v = cl.text(b[key], max);
    if (v !== undefined) data[key] = v;
  }
  return data;
}

// Keeps the case's legalStage (and its court, when the latest row names one)
// equal to the latest stage row. Inside the transaction that changed them.
async function syncCaseStage(tx, caseId) {
  const rows = await tx.caseStage.findMany({ where: { caseId, deletedAt: null }, select: { id: true, date: true, stage: true, court: true, deletedAt: true } });
  const latest = latestStage(rows);
  const data = { legalStage: latest ? latest.stage : null };
  if (latest?.court) data.court = latest.court;
  return tx.clientCase.update({ where: { id: caseId }, data });
}

module.exports = { HistoryError, normalizeStage, normalizeKeyDate, latestStage, syncCaseStage };
