const { isValidDate, shiftDate } = require("../lib/firmTime");
const cl = require("./clients");

// A case's history, beyond notes (tested in test/caseHistory.test.js):
//
//   stages  where the case has been and since when — one row per stage it
//           reached ("tergov 2026-03-12", "birinchi instansiya 2026-06-01").
//           Rows can carry past dates (a case brought in from before
//           Ledger), be corrected, or be removed (kept, hidden). A row can
//           also be planned — a date still ahead ("goes to court on 5
//           November", the boss, 2026-10-14): it shows as planned and becomes
//           the case's stage on its day (syncDueStages, every hour). The
//           case's legalStage is always the latest row reached by today (by
//           date, then by entry).
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

// How far ahead a stage can be planned (further: a typo in the year).
const PLAN_AHEAD_DAYS = 3 * 366;

function date(value, field, { notAfter } = {}) {
  if (value === undefined) return undefined;
  if (!isValidDate(value)) throw new HistoryError(`invalid ${field}`);
  if (notAfter && value > notAfter) throw new HistoryError(`${field} is too far ahead`);
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
  const day = date(b.date, "date", { notAfter: shiftDate(today, PLAN_AHEAD_DAYS) });
  if (day !== undefined) data.date = day;
  else if (!current.id) data.date = today;
  const court = cl.text(b.court, 200);
  if (court !== undefined) data.court = court;
  const note = cl.text(b.note, 2000);
  if (note !== undefined) data.note = note;
  return data;
}

// The latest stage of these rows reached by `today` (removed and planned
// ones don't count): by date, then by the order they were entered. null when
// there are none. Without `today`, every row counts.
function latestStage(rows, today) {
  const live = (rows || []).filter((r) => !r.deletedAt && (!today || r.date <= today));
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
// equal to the latest stage row reached by today. Inside the transaction
// that changed them.
async function syncCaseStage(tx, caseId, today) {
  const rows = await tx.caseStage.findMany({ where: { caseId, deletedAt: null }, select: { id: true, date: true, stage: true, court: true, deletedAt: true } });
  const latest = latestStage(rows, today);
  const data = { legalStage: latest ? latest.stage : null };
  if (latest?.court) data.court = latest.court;
  return tx.clientCase.update({ where: { id: caseId }, data });
}

// Planned stages whose day has come (in the last week — the server may have
// been off): their cases move on, and the timeline says so. Returns how many
// cases changed.
async function syncDueStages(db, today) {
  const due = await db.caseStage.findMany({ where: { deletedAt: null, date: { lte: today, gte: shiftDate(today, -7) } }, select: { caseId: true } });
  let changed = 0;
  for (const caseId of new Set(due.map((r) => r.caseId))) {
    const kase = await db.clientCase.findUnique({
      where: { id: caseId },
      select: { clientId: true, legalStage: true, stages: { where: { deletedAt: null }, select: { id: true, date: true, stage: true, court: true, deletedAt: true } } },
    });
    const latest = latestStage(kase?.stages, today);
    if (!kase || (latest?.stage ?? null) === kase.legalStage) continue;
    await db.$transaction(async (tx) => {
      await syncCaseStage(tx, caseId, today);
      await tx.clientEvent.create({ data: { clientId: kase.clientId, caseId, kind: "stage_row", text: "", data: { action: "reached", stage: latest.stage, date: latest.date } } });
    });
    changed += 1;
  }
  return changed;
}

module.exports = { HistoryError, PLAN_AHEAD_DAYS, normalizeStage, normalizeKeyDate, latestStage, syncCaseStage, syncDueStages };
