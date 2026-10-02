const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isManager, isLawyer } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { firmNow, shiftDate } = require("../lib/firmTime");
const { caseRole, CONTRACT_STATUSES } = require("../lib/clientAccess");
const { canSeeCaseMoney } = require("../lib/finance");
const { isCoordinator } = require("../lib/jobs");
const cl = require("../services/clients");
const history = require("../services/caseHistory");
const { scheduleOf } = require("../services/installments");
const { canUseClients } = require("./clients");

// A case's history and the work on it after the contract.
//
//   GET    /api/client-cases?view=mine        my cases: a coordinator's or a
//                                             lawyer's (managers: every open
//                                             contract), with what needs doing
//   GET    /api/client-cases?view=unassigned  managers: contracts without a
//                                             coordinator or a lawyer
//   GET    /api/client-cases/upcoming?days=   key dates coming up in my cases
//   POST   /api/client-cases/:id/stages       { stage, date, court?, note? }
//   PATCH  /api/client-stages/:id             correct a stage row
//   DELETE /api/client-stages/:id             remove it (kept, hidden)
//   POST   /api/client-cases/:id/dates        { kind, date, time?, title?, place?, note? }
//   PATCH  /api/client-dates/:id              change it, or write what happened (outcome)
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
    select: { id: true, clientId: true, status: true, operatorId: true, coordinatorId: true, lawyerId: true, client: { select: { createdById: true, archivedAt: true, cases: { select: { operatorId: true } } } } },
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
  if (isLawyer(user)) return { lawyerId: user.id, status: { in: CONTRACT_STATUSES } };
  if (isCoordinator(user.employee)) return { coordinatorId: user.employee.id };
  return { coordinatorId: user.employee?.id ?? -1 };
}

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
        coordinatorId: true,
        operatorId: true,
        client: { select: { id: true, name: true, nextCallAt: true, nextCallNote: true, phones: { select: { phone: true }, orderBy: { id: "asc" }, take: 1 } } },
        coordinator: { select: { id: true, name: true } },
        operator: { select: { id: true, name: true } },
        payments: { select: { amount: true, kind: true, date: true } },
        installments: { select: { dueDate: true, amount: true } },
        dates: { where: { deletedAt: null, date: { gte: now } }, orderBy: [{ date: "asc" }, { time: "asc" }], take: 1, select: { id: true, kind: true, date: true, time: true, title: true, place: true } },
        stages: { where: { deletedAt: null }, orderBy: [{ date: "desc" }, { id: "desc" }], take: 1, select: { stage: true, date: true } },
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
        stageSince: k.stages[0]?.date ?? null,
        court: k.court,
        contractDate: k.contractDate,
        lawyer: k.lawyer,
        lawyerId: k.lawyerId,
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

// Key dates coming up (today on) in the cases this person works on.
caseItems.get("/upcoming", async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const from = today();
    const caseWhere = isManager(req.user) ? {} : isLawyer(req.user) ? { lawyerId: req.user.id } : { coordinatorId: req.user.employee?.id ?? -1 };
    const rows = await prisma.caseDate.findMany({
      where: { deletedAt: null, date: { gte: from, lte: shiftDate(from, days) }, case: { ...caseWhere, client: { archivedAt: null } } },
      orderBy: [{ date: "asc" }, { time: "asc" }],
      take: 200,
      select: { id: true, kind: true, date: true, time: true, title: true, place: true, case: { select: { id: true, matter: true, client: { select: { id: true, name: true } } } } },
    });
    res.json(rows);
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
      await history.syncCaseStage(tx, kase.id);
      await logEvent(tx, req, kase, "stage_row", { action: "add", stage: created.stage, date: created.date, court: created.court ?? null });
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
      await history.syncCaseStage(tx, kase.id);
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
      await history.syncCaseStage(tx, kase.id);
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
