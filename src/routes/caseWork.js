const express = require("express");
const { displayName, LAWYER_NAME } = require("../lib/lawyers");
const prisma = require("../lib/prisma");
const { requireAuth, isManager, isLawyer } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { firmNow, shiftDate } = require("../lib/firmTime");
const { caseRole, CONTRACT_STATUSES, lawyerCaseWhere, EXTRA_LAWYERS } = require("../lib/clientAccess");
const { canSeeCaseMoney, canSeeFinance } = require("../lib/finance");
const { getSetting, setSetting } = require("../lib/settings");
const { isCoordinator } = require("../lib/jobs");
const cl = require("../services/clients");
const history = require("../services/caseHistory");
const { scheduleOf } = require("../services/installments");
const { canUseClients } = require("./clients");
const entries = require("../services/caseEntries");
const outcomes = require("../services/outcomes");

// A case's history and the work on it after the contract.
//
//   GET    /api/client-cases?view=mine        my cases: a coordinator's or a
//                                             lawyer's (managers: every open
//                                             contract), with what needs doing
//   GET    /api/client-cases?view=unassigned  managers: contracts without a
//                                             coordinator or a lawyer
//   GET    /api/client-cases/upcoming?days=   key dates coming up in my cases
//   POST   /api/client-cases/:id/stages       { stage, date, court?, note? } — a
//                                             date ahead: a planned stage
//   PATCH  /api/client-stages/:id             correct a stage row
//   DELETE /api/client-stages/:id             remove it (kept, hidden)
//   POST   /api/client-cases/:id/dates        { kind, date, time?, title?, place?, note? }
//   PATCH  /api/client-dates/:id              change it, or write what happened (outcome)
//   POST   /api/client-dates/:id/outcome      { text, result?, next?: { date, time?, place? }, fileId? } —
//                                             how a hearing went, once it's passed: the outcome, a
//                                             history entry, the next date; the team is told
//   GET    /api/client-cases/outcomes-due     hearings that took place with no outcome yet (mine)
//   GET    /api/client-cases/debts?days=14    who owes on my cases: overdue, due soon, later,
//                                             no schedule (coordinators; Moliya: all / a lawyer's own)
//   GET    /api/client-cases/deadline-days    the firm's days from a decision to its deadline, by stage
//   PUT    /api/client-cases/deadline-days    { stage, days } — remember one (lawyers, managers)
//   DELETE /api/client-dates/:id              remove it (kept, hidden)
//
// Who: the people on the case — managers, its lawyer, its coordinator. An
// operator works on the consultation, not on this. Every change goes to the
// client's timeline; corrections and removals to the audit log too.

const PERSON = { select: { id: true, username: true, employee: { select: { name: true } } } };
const HISTORY_ROLES = ["manager", "lawyer", "coordinator"];
const today = () => firmNow().date;

function gate(req, res, next) {
  if (!canUseClients(req.user)) return res.status(403).json({ error: "forbidden" });
  next();
}

function fail(status, error) {
  return Object.assign(new Error(error), { status });
}

function sendError(err, res, next) {
  if (err instanceof history.HistoryError || err instanceof cl.ClientError) return res.status(400).json({ error: err.message });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  return next(err);
}

// The case, if this person may work on its history; 404 when they may not
// see it at all, 403 when they see it but this isn't theirs to change.
async function caseForHistory(user, caseId) {
  const kase = await prisma.clientCase.findUnique({
    where: { id: caseId },
    select: { id: true, clientId: true, matter: true, status: true, operatorId: true, coordinatorId: true, lawyerId: true, extraLawyers: EXTRA_LAWYERS, client: { select: { createdById: true, archivedAt: true, cases: { select: { operatorId: true } } } } },
  });
  if (!kase) throw fail(404, "not_found");
  const role = caseRole(user, kase, kase.client);
  if (!role) throw fail(404, "not_found");
  if (!HISTORY_ROLES.includes(role)) throw fail(403, "forbidden");
  return kase;
}

const logEvent = (tx, req, kase, kind, data) =>
  tx.clientEvent.create({ data: { clientId: kase.clientId, caseId: kase.id, kind, text: "", data, authorId: req.user.id } });

const touch = (tx, clientId) => tx.client.update({ where: { id: clientId }, data: { updatedAt: new Date() } });

// ------------------------------------------------------------ the lists
const caseItems = express.Router();
caseItems.use(requireAuth, gate);

// Whose cases "mine" are.
function mineWhere(user) {
  if (isManager(user)) return { status: "contract" };
  if (isLawyer(user)) return { ...lawyerCaseWhere(user.id), status: { in: CONTRACT_STATUSES } };
  if (isCoordinator(user.employee)) return { coordinatorId: user.employee.id };
  return { coordinatorId: user.employee?.id ?? -1 };
}

// ------------------------------------------------------------- debts
// Who owes on the cases someone looks after, for a call and a word: overdue
// first (biggest), then due within `days`, then later, then debts with no
// schedule. Coordinators: theirs; Moliya: every case (a lawyer: theirs).
function debtScope(user) {
  if (canSeeFinance(user)) return isLawyer(user) ? lawyerCaseWhere(user.id) : {};
  if (isCoordinator(user.employee)) return { coordinatorId: user.employee.id };
  return null;
}

caseItems.get("/debts", async (req, res, next) => {
  try {
    const scope = debtScope(req.user);
    if (!scope) return res.status(403).json({ error: "forbidden" });
    const days = Math.min(60, Math.max(1, Number(req.query.days) || 14));
    const now = today();
    const soon = shiftDate(now, days);
    const rows = await prisma.clientCase.findMany({
      where: { ...scope, status: { in: CONTRACT_STATUSES }, contractAmount: { gt: 0 }, client: { archivedAt: null } },
      select: {
        id: true,
        matter: true,
        contractAmount: true,
        coordinator: { select: { id: true, name: true } },
        client: { select: { id: true, name: true, phones: { select: { phone: true }, orderBy: { id: "asc" }, take: 1 } } },
        payments: { select: { amount: true, kind: true, date: true } },
        installments: { select: { id: true, dueDate: true, amount: true } },
      },
    });
    const items = [];
    for (const k of rows) {
      const summary = cl.paymentSummary(k.contractAmount, k.payments);
      if (summary.remaining <= 0) continue;
      const schedule = k.installments.length ? scheduleOf(k.installments, k.payments, now) : null;
      const lastPaid = k.payments.filter((p) => p.kind !== "consultation").map((p) => p.date).sort().at(-1) ?? null;
      const group = !schedule || (!schedule.next && schedule.overdue === 0) ? "unscheduled" : schedule.overdue > 0 ? "overdue" : schedule.next && schedule.next.dueDate <= soon ? "soon" : "later";
      items.push({
        caseId: k.id,
        matter: k.matter,
        client: { id: k.client.id, name: k.client.name, phone: k.client.phones[0]?.phone ?? null },
        coordinator: k.coordinator,
        contractAmount: k.contractAmount,
        paid: summary.paid,
        remaining: summary.remaining,
        overdue: schedule?.overdue ?? 0,
        overdueSince: schedule?.overdueSince ?? null,
        next: schedule?.next ?? null,
        lastPaid,
        group,
      });
    }
    const order = { overdue: 0, soon: 1, later: 2, unscheduled: 3 };
    items.sort((a, b) => order[a.group] - order[b.group] || b.overdue - a.overdue || (a.next?.dueDate || "9").localeCompare(b.next?.dueDate || "9") || b.remaining - a.remaining);
    res.json({ today: now, days, items });
  } catch (err) {
    sendError(err, res, next);
  }
});

// ---------------------------------------------------- decision deadlines
// Days from a decision to the deadline it starts (an appeal…), by the stage
// the case is at — the firm's own numbers (Setting "deadlineDays"; nothing
// is assumed). The history form suggests the date (services/caseEntries.js).
const DEADLINE_KEY = "deadlineDays";

caseItems.get("/deadline-days", async (req, res, next) => {
  try {
    res.json(await getSetting(DEADLINE_KEY, {}));
  } catch (err) {
    sendError(err, res, next);
  }
});

caseItems.put("/deadline-days", async (req, res, next) => {
  try {
    if (!isManager(req.user) && !isLawyer(req.user)) return res.status(403).json({ error: "forbidden" });
    const stage = req.body?.stage == null || req.body.stage === "" ? "_" : String(req.body.stage);
    if (stage !== "_" && !cl.LEGAL_STAGES.includes(stage)) throw badRequest("invalid stage");
    const days = req.body?.days === null || req.body?.days === "" ? null : Number(req.body?.days);
    if (days !== null && (!Number.isInteger(days) || days <= 0 || days > 3650)) throw badRequest("invalid days");
    const current = { ...(await getSetting(DEADLINE_KEY, {})) };
    if (days === null) delete current[stage];
    else current[stage] = days;
    await setSetting(DEADLINE_KEY, current, req.user.id);
    res.json(current);
  } catch (err) {
    sendError(err, res, next);
  }
});

caseItems.get("/outcomes-due", async (req, res, next) => {
  try {
    const rows = await outcomes.listDue(req.user);
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        date: r.date,
        time: r.time,
        title: r.title,
        place: r.place,
        case: { id: r.case.id, matter: r.case.matter, number: r.case.number, clientId: r.case.clientId, clientName: r.case.client.name },
      })),
    });
  } catch (err) {
    sendError(err, res, next);
  }
});

caseItems.get("/", async (req, res, next) => {
  try {
    const view = req.query.view === "unassigned" ? "unassigned" : "mine";
    if (view === "unassigned" && !isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    const now = today();
    const where = view === "unassigned" ? { status: "contract", OR: [{ coordinatorId: null }, { lawyerId: null }] } : mineWhere(req.user);
    const rows = await prisma.clientCase.findMany({
      where: { ...where, client: { archivedAt: null } },
      orderBy: { updatedAt: "desc" },
      take: 400,
      select: {
        id: true,
        matter: true,
        number: true,
        status: true,
        legalStage: true,
        court: true,
        contractDate: true,
        contractAmount: true,
        lawyer: true,
        lawyerId: true,
        extraLawyers: { select: { user: { select: LAWYER_NAME } } },
        coordinatorId: true,
        operatorId: true,
        client: { select: { id: true, name: true, nextCallAt: true, nextCallNote: true, phones: { select: { phone: true }, orderBy: { id: "asc" }, take: 1 } } },
        coordinator: { select: { id: true, name: true } },
        operator: { select: { id: true, name: true } },
        payments: { select: { amount: true, kind: true, date: true } },
        installments: { select: { dueDate: true, amount: true } },
        dates: { where: { deletedAt: null, date: { gte: now } }, orderBy: [{ date: "asc" }, { time: "asc" }], take: 1, select: { id: true, kind: true, date: true, time: true, title: true, place: true } },
        stages: { where: { deletedAt: null }, orderBy: [{ date: "desc" }, { id: "desc" }], select: { stage: true, date: true } },
      },
    });
    const out = rows.map((k) => {
      const money = canSeeCaseMoney(req.user, k);
      const base = {
        id: k.id,
        matter: k.matter,
        number: k.number,
        status: k.status,
        legalStage: k.legalStage,
        stageSince: k.stages.find((r) => r.date <= now)?.date ?? null,
        // The next planned stage, if one is set (a date still ahead).
        plannedStage: k.stages.filter((r) => r.date > now).at(-1) ?? null,
        court: k.court,
        contractDate: k.contractDate,
        lawyer: k.lawyer,
        lawyerId: k.lawyerId,
        extraLawyers: k.extraLawyers.map((x) => ({ id: x.user.id, name: displayName(x.user) })),
        coordinator: k.coordinator,
        operator: k.operator,
        client: { id: k.client.id, name: k.client.name, phone: k.client.phones[0]?.phone ?? null, nextCallAt: k.client.nextCallAt, nextCallNote: k.client.nextCallNote },
        nextDate: k.dates[0] ?? null,
      };
      if (!money) return base;
      const summary = cl.paymentSummary(k.contractAmount, k.payments);
      const schedule = k.installments.length ? scheduleOf(k.installments, k.payments, now) : null;
      return {
        ...base,
        contractAmount: k.contractAmount,
        paid: summary.paid,
        remaining: summary.remaining,
        overdue: schedule?.overdue ?? 0,
        overdueSince: schedule?.overdueSince ?? null,
        nextDue: schedule?.next ?? null,
      };
    });
    res.json({ view, cases: out });
  } catch (err) {
    sendError(err, res, next);
  }
});

// Key dates coming up (today on) in the cases this person works on — and
// the stages planned in that time (kind "stage", with `stage`).
caseItems.get("/upcoming", async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const from = today();
    const caseWhere = isManager(req.user) ? {} : isLawyer(req.user) ? lawyerCaseWhere(req.user.id) : { coordinatorId: req.user.employee?.id ?? -1 };
    const window = { gte: from, lte: shiftDate(from, days) };
    const CASE = { select: { id: true, matter: true, client: { select: { id: true, name: true } } } };
    const [rows, planned] = await Promise.all([
      prisma.caseDate.findMany({
        where: { deletedAt: null, date: window, case: { ...caseWhere, client: { archivedAt: null } } },
        orderBy: [{ date: "asc" }, { time: "asc" }],
        take: 200,
        select: { id: true, kind: true, date: true, time: true, title: true, place: true, case: CASE },
      }),
      prisma.caseStage.findMany({
        where: { deletedAt: null, date: { ...window, gt: from }, case: { ...caseWhere, client: { archivedAt: null } } },
        orderBy: { date: "asc" },
        take: 100,
        select: { id: true, stage: true, date: true, court: true, case: CASE },
      }),
    ]);
    const stages = planned.map((r) => ({ id: `s${r.id}`, kind: "stage", stage: r.stage, date: r.date, time: null, title: null, place: r.court, case: r.case }));
    res.json([...rows, ...stages].sort((a, b) => (a.date === b.date ? (a.time ?? -1) - (b.time ?? -1) : a.date < b.date ? -1 : 1)));
  } catch (err) {
    sendError(err, res, next);
  }
});

// ------------------------------------------------------------- stages
caseItems.post("/:id/stages", async (req, res, next) => {
  try {
    const kase = await caseForHistory(req.user, parseId(req.params.id));
    const data = history.normalizeStage(req.body, {}, today());
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.caseStage.create({ data: { ...data, caseId: kase.id, createdById: req.user.id } });
      await history.syncCaseStage(tx, kase.id, today());
      await logEvent(tx, req, kase, "stage_row", { action: created.date > today() ? "plan" : "add", stage: created.stage, date: created.date, court: created.court ?? null });
      await touch(tx, kase.clientId);
      return created;
    });
    res.status(201).json(row);
  } catch (err) {
    sendError(err, res, next);
  }
});

const stages = express.Router();
stages.use(requireAuth, gate);

async function stageRow(req) {
  const row = await prisma.caseStage.findUnique({ where: { id: parseId(req.params.id) } });
  if (!row || row.deletedAt) throw fail(404, "not_found");
  const kase = await caseForHistory(req.user, row.caseId);
  return { row, kase };
}

stages.patch("/:id", async (req, res, next) => {
  try {
    const { row, kase } = await stageRow(req);
    const data = history.normalizeStage(req.body, row, today());
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.caseStage.update({ where: { id: row.id }, data });
      await history.syncCaseStage(tx, kase.id, today());
      await logEvent(tx, req, kase, "stage_row", { action: "edit", stage: u.stage, date: u.date, before: { stage: row.stage, date: row.date } });
      await tx.auditLog.create({ data: { userId: req.user.id, action: "stage.edit", entity: "case", entityId: kase.id, detail: { clientId: kase.clientId, before: row, after: u } } });
      await touch(tx, kase.clientId);
      return u;
    });
    res.json(updated);
  } catch (err) {
    sendError(err, res, next);
  }
});

stages.delete("/:id", async (req, res, next) => {
  try {
    const { row, kase } = await stageRow(req);
    await prisma.$transaction(async (tx) => {
      await tx.caseStage.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
      await history.syncCaseStage(tx, kase.id, today());
      await logEvent(tx, req, kase, "stage_row", { action: "remove", stage: row.stage, date: row.date });
      await tx.auditLog.create({ data: { userId: req.user.id, action: "stage.delete", entity: "case", entityId: kase.id, detail: { clientId: kase.clientId, row } } });
      await touch(tx, kase.clientId);
    });
    res.status(204).end();
  } catch (err) {
    sendError(err, res, next);
  }
});

// ----------------------------------------------------------- key dates
caseItems.post("/:id/dates", async (req, res, next) => {
  try {
    const kase = await caseForHistory(req.user, parseId(req.params.id));
    const data = history.normalizeKeyDate(req.body, {});
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.caseDate.create({ data: { ...data, caseId: kase.id, createdById: req.user.id }, include: { createdBy: PERSON } });
      await logEvent(tx, req, kase, "date_row", { action: "add", kind: created.kind, date: created.date, time: created.time, title: created.title });
      await touch(tx, kase.clientId);
      return created;
    });
    res.status(201).json(row);
  } catch (err) {
    sendError(err, res, next);
  }
});

const dates = express.Router();
dates.use(requireAuth, gate);

async function dateRow(req) {
  const row = await prisma.caseDate.findUnique({ where: { id: parseId(req.params.id) } });
  if (!row || row.deletedAt) throw fail(404, "not_found");
  const kase = await caseForHistory(req.user, row.caseId);
  return { row, kase };
}

dates.patch("/:id", async (req, res, next) => {
  try {
    const { row, kase } = await dateRow(req);
    const data = history.normalizeKeyDate(req.body, row);
    if (Object.keys(data).length === 0) throw badRequest("nothing to change");
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.caseDate.update({ where: { id: row.id }, data, include: { createdBy: PERSON } });
      // Writing what happened is news; moving the date is a correction.
      const action = data.outcome !== undefined && Object.keys(data).length === 1 ? "outcome" : "edit";
      await logEvent(tx, req, kase, "date_row", { action, kind: u.kind, date: u.date, time: u.time, title: u.title, outcome: u.outcome ?? null, before: action === "edit" ? { date: row.date, time: row.time } : undefined });
      if (action === "edit") await tx.auditLog.create({ data: { userId: req.user.id, action: "date.edit", entity: "case", entityId: kase.id, detail: { clientId: kase.clientId, before: row, after: u } } });
      await touch(tx, kase.clientId);
      return u;
    });
    res.json(updated);
  } catch (err) {
    sendError(err, res, next);
  }
});

dates.post("/:id/outcome", async (req, res, next) => {
  try {
    const { row, kase } = await dateRow(req);
    if (!outcomes.OUTCOME_KINDS.includes(row.kind)) throw badRequest("not a hearing");
    if (row.outcome) throw fail(409, "outcome_exists");
    if (!outcomes.hasPassed(row, firmNow()) && row.date > today()) throw badRequest("not yet");
    const b = req.body || {};
    let e;
    try {
      e = entries.normalizeEntry({ type: "hearing", text: b.text, result: b.result, on: row.date, next: b.next, fileId: b.fileId }, today());
    } catch (err) {
      if (err instanceof entries.EntryError) throw badRequest(err.message);
      throw err;
    }
    if (e.data.fileId) {
      const file = await prisma.clientFile.findFirst({ where: { id: e.data.fileId, clientId: kase.clientId, deletedAt: null, OR: [{ caseId: null }, { caseId: kase.id }] }, select: { id: true } });
      if (!file) throw badRequest("file is not this case's");
    }
    const result = await prisma.$transaction(async (tx) => {
      const outcomeText = [outcomes.RESULT_WORDS[e.data.result], e.text].filter(Boolean).join(". ");
      // Two people answering at once: the first one counts.
      const claimed = await tx.caseDate.updateMany({ where: { id: row.id, outcome: null }, data: { outcome: outcomeText, outcomeAt: new Date(), outcomeById: req.user.id } });
      if (claimed.count === 0) throw fail(409, "outcome_exists");
      const updated = await tx.caseDate.findUnique({ where: { id: row.id } });
      let nextRow = null;
      if (e.next) {
        // The next one of the same kind (an interrogation continues as one).
        nextRow = await entries.addKeyDate(tx, { kase, userId: req.user.id, kind: row.kind, ...e.next });
        e.data.nextDateId = nextRow.id;
        e.data.next = { date: nextRow.date, time: nextRow.time, place: nextRow.place };
      }
      e.data.dateId = row.id;
      e.data.dateKind = row.kind;
      if (row.time != null) e.data.time = row.time;
      if (row.place && !e.data.place) e.data.place = row.place;
      const entry = await tx.clientEvent.create({ data: { clientId: kase.clientId, caseId: kase.id, kind: "note", text: e.text, data: e.data, authorId: req.user.id } });
      await touch(tx, kase.clientId);
      return { date: updated, next: nextRow, entry };
    });
    // The team hears it in the client's chat (which case, when they have several).
    const several = kase.client.cases.length > 1;
    const line = outcomes.outcomeLine(row, { result: e.data.result, text: e.text, next: result.next });
    require("../services/chat")
      .postToClient(kase.clientId, req.user, several && kase.matter ? `${kase.matter}\n${line}` : line)
      .catch((err) => console.error("[outcome] team post failed:", err.message));
    res.status(201).json(result);
  } catch (err) {
    sendError(err, res, next);
  }
});

dates.delete("/:id", async (req, res, next) => {
  try {
    const { row, kase } = await dateRow(req);
    await prisma.$transaction(async (tx) => {
      await tx.caseDate.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
      await logEvent(tx, req, kase, "date_row", { action: "remove", kind: row.kind, date: row.date, title: row.title });
      await tx.auditLog.create({ data: { userId: req.user.id, action: "date.delete", entity: "case", entityId: kase.id, detail: { clientId: kase.clientId, row } } });
      await touch(tx, kase.clientId);
    });
    res.status(204).end();
  } catch (err) {
    sendError(err, res, next);
  }
});

module.exports = { caseItems, stages, dates };
