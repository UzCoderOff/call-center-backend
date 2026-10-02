const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isManager } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { firmDate } = require("../lib/firmTime");
const { setSetting } = require("../lib/settings");
const { asksForm } = require("../services/autoReport");
const s = require("../services/strikes");

// The firm's rules for the call center, and what follows from them.
//
//   GET  /api/rules/strikes        the late call-back rule (staff: what it asks of them)
//   PUT  /api/rules/strikes        change it (developer)
//   GET  /api/rules/call-center    who counts as the call center, and what to pick by
//   PUT  /api/rules/call-center    { add: [employeeId], remove: [employeeId] } (developer)
//   GET  /api/strikes?month=&employeeId=   strikes (managers: anyone's; staff: their own)
//   POST /api/strikes/:id/cancel   { reason } (managers) — kept, marked
//   POST /api/strikes/:id/restore  (managers)
//
// Like other staff settings, the developer changes them; the boss sees them.

const rules = express.Router();
rules.use(requireAuth);

const developerOnly = (req, res, next) => (req.user.role === "DEVELOPER" ? next() : res.status(403).json({ error: "forbidden" }));
const managersOnly = (req, res, next) => (isManager(req.user) ? next() : res.status(403).json({ error: "forbidden" }));

function sendError(err, res, next) {
  if (err instanceof s.RuleError) return res.status(400).json({ error: err.message });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  return next(err);
}

rules.get("/strikes", async (req, res, next) => {
  try {
    const r = await s.strikeRules();
    if (isManager(req.user)) return res.json({ ...r, canEdit: req.user.role === "DEVELOPER" });
    res.json({ enabled: r.enabled, minutes: r.minutes, from: r.from, to: r.to, limit: r.limit });
  } catch (err) {
    sendError(err, res, next);
  }
});

rules.put("/strikes", developerOnly, async (req, res, next) => {
  try {
    const current = await s.strikeRules();
    const next_ = s.normalizeRules(req.body, current);
    await setSetting("strikes", next_, req.user.id);
    await prisma.auditLog.create({ data: { userId: req.user.id, action: "rules.strikes", entity: "setting", entityId: null, detail: { before: current, after: next_ } } });
    res.json({ ...next_, canEdit: true });
  } catch (err) {
    sendError(err, res, next);
  }
});

// Who counts as the call center: everyone whose job is "call center" (Team
// → person). Here many at once — by position, office or report form, or one
// by one.
rules.get("/call-center", managersOnly, async (req, res, next) => {
  try {
    const [people, positions, offices, templates] = await Promise.all([
      prisma.employee.findMany({
        where: { active: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, job: true, collectCalls: true, positionId: true, officeId: true, reportTemplateId: true, position: { select: { name: true } }, office: { select: { name: true } } },
      }),
      prisma.position.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
      prisma.office.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
      prisma.reportTemplate.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    ]);
    res.json({ people, positions, offices, templates, canEdit: req.user.role === "DEVELOPER" });
  } catch (err) {
    sendError(err, res, next);
  }
});

rules.put("/call-center", developerOnly, async (req, res, next) => {
  try {
    const ids = (list) => (Array.isArray(list) ? [...new Set(list.map((x) => parseId(x, "employeeId")))] : []);
    const add = ids(req.body?.add);
    const remove = ids(req.body?.remove);
    if (add.some((id) => remove.includes(id))) throw badRequest("same person in add and remove");
    if (add.length + remove.length > 500) throw badRequest("too many");
    const leaving = remove.length ? await prisma.employee.findMany({ where: { id: { in: remove }, job: "call_center" } }) : [];
    await prisma.$transaction(async (tx) => {
      if (add.length) await tx.employee.updateMany({ where: { id: { in: add } }, data: { job: "call_center" } });
      // Out of the call center: office work if they fill in a report form,
      // otherwise "other" (changeable on their page).
      for (const e of leaving) await tx.employee.update({ where: { id: e.id }, data: { job: asksForm(e) ? "office" : "other" } });
      await tx.auditLog.create({ data: { userId: req.user.id, action: "rules.callCenter", entity: "setting", entityId: null, detail: { add, remove: leaving.map((e) => e.id) } } });
    });
    res.json({ added: add.length, removed: leaving.length });
  } catch (err) {
    sendError(err, res, next);
  }
});

// ------------------------------------------------------------- strikes
const strikes = express.Router();
strikes.use(requireAuth);

const STRIKE_INCLUDE = {
  employee: { select: { id: true, name: true } },
  cancelledBy: { select: { id: true, username: true, name: true, employee: { select: { name: true } } } },
  callLog: { select: { id: true, phoneNumber: true, callType: true } },
};

strikes.get("/", async (req, res, next) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : firmDate().slice(0, 7);
    let employeeId = req.query.employeeId ? parseId(req.query.employeeId, "employeeId") : null;
    if (!isManager(req.user)) employeeId = req.user.employee?.id ?? -1;
    const rows = await prisma.strike.findMany({
      where: { month, ...(employeeId ? { employeeId } : {}) },
      orderBy: { missedAt: "desc" },
      include: STRIKE_INCLUDE,
    });
    const r = await s.strikeRules();
    res.json({ month, rules: { enabled: r.enabled, minutes: r.minutes, limit: r.limit, fine: isManager(req.user) ? r.fine : undefined }, strikes: rows });
  } catch (err) {
    sendError(err, res, next);
  }
});

strikes.post("/:id/cancel", managersOnly, async (req, res, next) => {
  try {
    const strike = await prisma.strike.findUnique({ where: { id: parseId(req.params.id) } });
    if (!strike) return res.status(404).json({ error: "not_found" });
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 300) : "";
    if (!reason) throw badRequest("reason is required");
    const updated = await prisma.strike.update({
      where: { id: strike.id },
      data: { cancelledAt: new Date(), cancelledById: req.user.id, cancelReason: reason },
      include: STRIKE_INCLUDE,
    });
    await prisma.auditLog.create({ data: { userId: req.user.id, action: "strike.cancel", entity: "employee", entityId: strike.employeeId, detail: { strikeId: strike.id, reason } } });
    res.json(updated);
  } catch (err) {
    sendError(err, res, next);
  }
});

strikes.post("/:id/restore", managersOnly, async (req, res, next) => {
  try {
    const strike = await prisma.strike.findUnique({ where: { id: parseId(req.params.id) } });
    if (!strike) return res.status(404).json({ error: "not_found" });
    const updated = await prisma.strike.update({ where: { id: strike.id }, data: { cancelledAt: null, cancelledById: null, cancelReason: null }, include: STRIKE_INCLUDE });
    await prisma.auditLog.create({ data: { userId: req.user.id, action: "strike.restore", entity: "employee", entityId: strike.employeeId, detail: { strikeId: strike.id } } });
    res.json(updated);
  } catch (err) {
    sendError(err, res, next);
  }
});

module.exports = { rules, strikes };
