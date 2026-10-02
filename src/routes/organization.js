const express = require("express");
const { normalizePattern } = require("../services/workdays");
const prisma = require("../lib/prisma");
const { requireAuth, requireRole, MANAGER_ROLES } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { normalizeFields } = require("../services/reportFields");

// How the firm is organised — all configurable from the portal:
//   /api/offices           the physical offices (by the court, translation office…)
//   /api/positions         job presets (call-center operator, translator…)
//   /api/report-templates  daily report forms
// BOSS and DEVELOPER can read them; only DEVELOPER changes them.

function cleanName(value, field = "name") {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} is required`);
  return value.trim().slice(0, 120);
}

function optionalId(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return parseId(value, field);
}

const { JOBS } = require("../lib/jobs");

// What people in this position do (a preset for Employee.job).
function job(value) {
  if (value === undefined) return undefined;
  if (!JOBS.includes(value)) throw badRequest("invalid job");
  return value;
}

function calendarAccess(value) {
  if (value === undefined) return undefined;
  if (!["none", "view", "book"].includes(value)) throw badRequest("invalid calendarAccess");
  return value;
}

// A monthly target: a whole number, or null for "no target".
function target(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100000) throw badRequest(`invalid ${field}`);
  return n;
}

function handleKnownErrors(err, res, next) {
  if (err.code === "P2002") return res.status(409).json({ error: "name_taken" });
  if (err.code === "P2025") return res.status(404).json({ error: "not_found" });
  if (err.code === "P2003") return res.status(400).json({ error: "invalid_reference" });
  return next(err);
}

// ---------------------------------------------------------------- offices
const offices = express.Router();
offices.use(requireAuth, requireRole(...MANAGER_ROLES));

offices.get("/", async (req, res, next) => {
  try {
    const rows = await prisma.office.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { employees: { where: { active: true } } } } },
    });
    res.json(rows.map(({ _count, ...o }) => ({ ...o, employeeCount: _count.employees })));
  } catch (err) {
    next(err);
  }
});

offices.post("/", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const office = await prisma.office.create({
      data: { name: cleanName(req.body?.name), address: req.body?.address?.trim?.() || null },
    });
    res.status(201).json(office);
  } catch (err) {
    handleKnownErrors(err, res, next);
  }
});

offices.patch("/:id", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const { name, address, active } = req.body || {};
    const office = await prisma.office.update({
      where: { id: parseId(req.params.id) },
      data: {
        ...(name !== undefined ? { name: cleanName(name) } : {}),
        ...(address !== undefined ? { address: address?.trim?.() || null } : {}),
        ...(typeof active === "boolean" ? { active } : {}),
      },
    });
    res.json(office);
  } catch (err) {
    handleKnownErrors(err, res, next);
  }
});

offices.delete("/:id", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    // Staff in a deleted office simply become "no office" (onDelete: SetNull).
    await prisma.office.delete({ where: { id: parseId(req.params.id) } });
    res.status(204).end();
  } catch (err) {
    handleKnownErrors(err, res, next);
  }
});

// -------------------------------------------------------------- positions
const positions = express.Router();
positions.use(requireAuth, requireRole(...MANAGER_ROLES));

const POSITION_INCLUDE = { reportTemplate: { select: { id: true, name: true } } };

positions.get("/", async (req, res, next) => {
  try {
    res.json(await prisma.position.findMany({ orderBy: { name: "asc" }, include: POSITION_INCLUDE }));
  } catch (err) {
    next(err);
  }
});

// Weekdays as digits ("123456"); undefined when not given or not valid.
function workPattern(value) {
  if (value === undefined) return undefined;
  const pattern = normalizePattern(value);
  if (!pattern) throw badRequest("invalid workDays");
  return pattern;
}

positions.post("/", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const position = await prisma.position.create({
      data: {
        name: cleanName(req.body?.name),
        collectCalls: Boolean(req.body?.collectCalls),
        autoReport: Boolean(req.body?.autoReport),
        alsoForm: Boolean(req.body?.alsoForm),
        calendarAccess: calendarAccess(req.body?.calendarAccess) ?? "none",
        job: job(req.body?.job) ?? "other",
        reportTemplateId: optionalId(req.body?.reportTemplateId, "reportTemplateId") ?? null,
        workDays: workPattern(req.body?.workDays) ?? (req.body?.collectCalls ? "1234567" : "123456"),
        holidaysOff: typeof req.body?.holidaysOff === "boolean" ? req.body.holidaysOff : !req.body?.collectCalls,
        targetConsultations: target(req.body?.targetConsultations, "targetConsultations") ?? null,
        targetContracts: target(req.body?.targetContracts, "targetContracts") ?? null,
      },
      include: POSITION_INCLUDE,
    });
    res.status(201).json(position);
  } catch (err) {
    handleKnownErrors(err, res, next);
  }
});

positions.patch("/:id", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const { name, collectCalls, autoReport, alsoForm, reportTemplateId } = req.body || {};
    const templateId = optionalId(reportTemplateId, "reportTemplateId");
    const access = calendarAccess(req.body?.calendarAccess);
    const targets = {
      targetConsultations: target(req.body?.targetConsultations, "targetConsultations"),
      targetContracts: target(req.body?.targetContracts, "targetContracts"),
    };
    for (const key of Object.keys(targets)) if (targets[key] === undefined) delete targets[key];
    const position = await prisma.position.update({
      where: { id: parseId(req.params.id) },
      data: {
        ...(name !== undefined ? { name: cleanName(name) } : {}),
        ...(typeof collectCalls === "boolean" ? { collectCalls } : {}),
        ...(typeof autoReport === "boolean" ? { autoReport } : {}),
        ...(typeof alsoForm === "boolean" ? { alsoForm } : {}),
        ...(access !== undefined ? { calendarAccess: access } : {}),
        ...(job(req.body?.job) !== undefined ? { job: job(req.body.job) } : {}),
        ...(templateId !== undefined ? { reportTemplateId: templateId } : {}),
        ...(workPattern(req.body?.workDays) ? { workDays: workPattern(req.body.workDays) } : {}),
        ...(typeof req.body?.holidaysOff === "boolean" ? { holidaysOff: req.body.holidaysOff } : {}),
        ...targets,
      },
      include: POSITION_INCLUDE,
    });
    res.json(position);
  } catch (err) {
    handleKnownErrors(err, res, next);
  }
});

positions.delete("/:id", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    await prisma.position.delete({ where: { id: parseId(req.params.id) } });
    res.status(204).end();
  } catch (err) {
    handleKnownErrors(err, res, next);
  }
});

// ------------------------------------------------------- report templates
const templates = express.Router();
templates.use(requireAuth, requireRole(...MANAGER_ROLES));

templates.get("/", async (req, res, next) => {
  try {
    const rows = await prisma.reportTemplate.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      include: { _count: { select: { employees: { where: { active: true } }, reports: true } } },
    });
    res.json(rows.map(({ _count, ...t }) => ({ ...t, employeeCount: _count.employees, reportCount: _count.reports })));
  } catch (err) {
    next(err);
  }
});

templates.get("/:id", async (req, res, next) => {
  try {
    const template = await prisma.reportTemplate.findUnique({ where: { id: parseId(req.params.id) } });
    if (!template) return res.status(404).json({ error: "not_found" });
    res.json(template);
  } catch (err) {
    next(err);
  }
});

templates.post("/", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const template = await prisma.reportTemplate.create({
      data: { name: cleanName(req.body?.name), fields: normalizeFields(req.body?.fields) },
    });
    res.status(201).json(template);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    handleKnownErrors(err, res, next);
  }
});

// Editing a form affects reports from now on; submitted reports keep the
// snapshot of the questions they were answered with.
templates.patch("/:id", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const { name, fields, active } = req.body || {};
    const template = await prisma.reportTemplate.update({
      where: { id: parseId(req.params.id) },
      data: {
        ...(name !== undefined ? { name: cleanName(name) } : {}),
        ...(fields !== undefined ? { fields: normalizeFields(fields) } : {}),
        ...(typeof active === "boolean" ? { active } : {}),
      },
    });
    res.json(template);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    handleKnownErrors(err, res, next);
  }
});

// A form that already has reports can't be deleted (they reference it) —
// switch it off (active: false) instead.
templates.delete("/:id", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const used = await prisma.report.count({ where: { templateId: id } });
    if (used > 0) return res.status(409).json({ error: "has_reports" });
    await prisma.reportTemplate.delete({ where: { id } });
    res.status(204).end();
  } catch (err) {
    handleKnownErrors(err, res, next);
  }
});

module.exports = { offices, positions, templates };
