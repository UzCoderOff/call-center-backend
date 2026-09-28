const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, requireRole, MANAGER_ROLES } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { firmDate, firmDayRange, isValidDate, shiftDate } = require("../lib/firmTime");
const { validateAnswers, summarize } = require("../services/reportFields");
const { computeCallStats } = require("../services/stats");
const { autoReportDays, addUp, checkRange, MAX_DAYS } = require("../services/autoReport");

// Daily reports. Everyone with a report form fills in one report per day
// (the firm's calendar day). Managers see, per day and office, who
// submitted and who didn't, plus totals of the numeric questions, and can
// mark reports as reviewed with a comment. People with an automatic report
// (call-center staff) fill in nothing: their day is worked out from their
// calls, bookings and clients (src/services/autoReport.js).
const router = express.Router();
router.use(requireAuth);

const isManager = (req) => MANAGER_ROLES.includes(req.user.role);

const AUTO_EMPLOYEE = { id: true, name: true, userId: true, collectCalls: true, autoReport: true, office: { select: { id: true, name: true } } };

const REPORT_INCLUDE = {
  employee: { select: { id: true, name: true, collectCalls: true, office: { select: { id: true, name: true } } } },
  template: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, username: true, employee: { select: { name: true } } } },
};

async function callStatsForDay(employee, date) {
  if (!employee?.collectCalls) return null;
  const { from, to } = firmDayRange(date);
  const { totals } = await computeCallStats({ employeeIds: [employee.id], from, to });
  return totals;
}

async function activeTemplateFor(employee) {
  if (!employee?.reportTemplateId) return null;
  const template = await prisma.reportTemplate.findUnique({ where: { id: employee.reportTemplateId } });
  return template?.active ? template : null;
}

// The signed-in person's report for today: their form, what they've
// already submitted (if anything), and — for call-center staff — today's
// call numbers so they don't have to count them by hand.
router.get("/today", async (req, res, next) => {
  try {
    const date = firmDate();
    const employee = req.user.employee;
    if (employee?.autoReport) {
      const [day] = await autoReportDays(employee, date, date);
      return res.json({ date, auto: day, template: null, report: null, callStats: null });
    }
    const template = await activeTemplateFor(employee);
    if (!template) return res.json({ date, template: null, report: null, callStats: null });

    const [report, callStats] = await Promise.all([
      prisma.report.findUnique({
        where: { employeeId_templateId_date: { employeeId: employee.id, templateId: template.id, date } },
        include: REPORT_INCLUDE,
      }),
      callStatsForDay(employee, date),
    ]);
    res.json({ date, template: { id: template.id, name: template.name, fields: template.fields }, report, callStats });
  } catch (err) {
    next(err);
  }
});

// Submit (or correct) today's report. Only today's — no back-filling — and
// only until a manager has reviewed it.
router.put("/today", async (req, res, next) => {
  try {
    const date = firmDate();
    const employee = req.user.employee;
    if (employee?.autoReport) return res.status(409).json({ error: "automatic_report" });
    const template = await activeTemplateFor(employee);
    if (!template) return res.status(409).json({ error: "no_report_form" });

    const { answers, errors } = validateAnswers(template.fields, req.body?.answers);
    if (Object.keys(errors).length > 0) return res.status(400).json({ error: "invalid_answers", fields: errors });

    const key = { employeeId_templateId_date: { employeeId: employee.id, templateId: template.id, date } };
    const existing = await prisma.report.findUnique({ where: key });
    if (existing?.reviewedAt) return res.status(409).json({ error: "already_reviewed" });

    const report = await prisma.report.upsert({
      where: key,
      create: { employeeId: employee.id, templateId: template.id, date, fields: template.fields, answers },
      update: { fields: template.fields, answers },
      include: REPORT_INCLUDE,
    });
    res.json(report);
  } catch (err) {
    next(err);
  }
});

// One day at a glance, for managers: every active person who has a report
// form, whether they've submitted, and totals per form; everyone with an
// automatic report, with that day's numbers and the team's totals.
router.get("/day", requireRole(...MANAGER_ROLES), async (req, res, next) => {
  try {
    const date = req.query.date ? String(req.query.date) : firmDate();
    if (!isValidDate(date)) throw badRequest("invalid date");
    const officeId = req.query.officeId ? parseId(req.query.officeId, "officeId") : null;
    const officeWhere = officeId ? { officeId } : {};

    const [employees, reports] = await Promise.all([
      prisma.employee.findMany({
        where: { active: true, OR: [{ reportTemplateId: { not: null } }, { autoReport: true }], ...officeWhere },
        select: {
          ...AUTO_EMPLOYEE,
          reportTemplate: { select: { id: true, name: true, active: true } },
        },
        orderBy: { name: "asc" },
      }),
      prisma.report.findMany({
        where: { date, ...(officeId ? { employee: { officeId } } : {}) },
        include: REPORT_INCLUDE,
      }),
    ]);

    const reportFor = (employeeId, templateId) => reports.find((r) => r.employeeId === employeeId && r.templateId === templateId);
    const automatic = employees.filter((e) => e.autoReport);
    const autoDays = await Promise.all(automatic.map((e) => autoReportDays(e, date, date).then(([day]) => day)));
    const rows = [
      ...automatic.map((e, i) => ({ employee: { id: e.id, name: e.name, office: e.office }, template: null, report: null, auto: autoDays[i] })),
      ...employees
        .filter((e) => !e.autoReport && e.reportTemplate?.active)
        .map((e) => {
          const report = reportFor(e.id, e.reportTemplate.id);
          return {
            employee: { id: e.id, name: e.name, office: e.office },
            template: { id: e.reportTemplate.id, name: e.reportTemplate.name },
            report: report ? summaryOf(report) : null,
          };
        }),
    ];
    // Reports that were sent anyway (by someone no longer expected —
    // deactivated, form changed, switched to automatic) still count and show.
    const shown = new Set(rows.filter((r) => r.report).map((r) => r.report.id));
    for (const r of reports) {
      if (!shown.has(r.id)) {
        rows.push({ employee: { id: r.employee.id, name: r.employee.name, office: r.employee.office }, template: r.template, report: summaryOf(r) });
      }
    }
    rows.sort((a, b) => a.employee.name.localeCompare(b.employee.name));

    const byTemplate = new Map();
    for (const row of rows) {
      if (!row.template) continue;
      if (!byTemplate.has(row.template.id)) byTemplate.set(row.template.id, { template: row.template, expected: 0, reports: [] });
      byTemplate.get(row.template.id).expected += 1;
    }
    for (const r of reports) byTemplate.get(r.templateId)?.reports.push(r);

    const forms = [...byTemplate.values()].map(({ template, expected, reports: rs }) => {
      // Summarise with the questions as most recently answered that day.
      const latest = rs.reduce((a, b) => (!a || b.updatedAt > a.updatedAt ? b : a), null);
      return {
        template,
        expected,
        submitted: rs.length,
        totals: latest ? summarize(latest.fields, rs) : [],
      };
    });

    const auto = autoDays.length ? { people: autoDays.length, totals: addUp(autoDays) } : null;
    res.json({ date, today: firmDate(), rows, forms, auto });
  } catch (err) {
    next(err);
  }
});

function summaryOf(report) {
  return {
    id: report.id,
    submittedAt: report.submittedAt,
    updatedAt: report.updatedAt,
    reviewedAt: report.reviewedAt,
  };
}

// Report history. EMPLOYEE: their own. Managers: anyone's (?employeeId=).
router.get("/", async (req, res, next) => {
  try {
    const pageSize = Math.min(Number(req.query.pageSize) || 30, 100);
    const page = Math.max(Number(req.query.page) || 1, 1);
    let where;
    if (isManager(req)) {
      where = req.query.employeeId ? { employeeId: parseId(req.query.employeeId, "employeeId") } : {};
    } else {
      where = { employeeId: req.user.employee?.id ?? -1 };
    }

    const [reports, total] = await Promise.all([
      prisma.report.findMany({
        where,
        orderBy: [{ date: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          date: true,
          submittedAt: true,
          reviewedAt: true,
          employee: { select: { id: true, name: true } },
          template: { select: { id: true, name: true } },
        },
      }),
      prisma.report.count({ where }),
    ]);
    res.json({ reports, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  } catch (err) {
    next(err);
  }
});

// Automatic reports: one person's day (?date=), or a run of days
// (?from=&to=, newest first) for their history. Managers: anyone's
// (?employeeId=); everyone else: their own.
router.get("/auto", async (req, res, next) => {
  try {
    const own = req.user.employee?.id ?? null;
    const employeeId = req.query.employeeId ? parseId(req.query.employeeId, "employeeId") : own;
    if (employeeId == null || (!isManager(req) && employeeId !== own)) return res.status(404).json({ error: "not_found" });
    const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: AUTO_EMPLOYEE });
    if (!employee) return res.status(404).json({ error: "not_found" });

    const today = firmDate();
    const to = String(req.query.to || req.query.date || today);
    // ?days=14: the 14 days up to `to` (the firm's dates, not the phone's).
    const span = Math.min(Math.max(Number(req.query.days) || 1, 1), MAX_DAYS);
    const from = String(req.query.from || req.query.date || (isValidDate(to) ? shiftDate(to, 1 - span) : to));
    const problem = checkRange(from, to, today);
    if (problem) throw badRequest(problem);

    const days = await autoReportDays(employee, from, to);
    const { userId, ...person } = employee;
    res.json({ employee: person, today, days: days.reverse() });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const report = await prisma.report.findUnique({ where: { id: parseId(req.params.id) }, include: REPORT_INCLUDE });
    if (!report || (!isManager(req) && report.employeeId !== req.user.employee?.id)) {
      return res.status(404).json({ error: "not_found" });
    }
    const callStats = await callStatsForDay(report.employee, report.date);
    res.json({ ...report, callStats });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/review", requireRole(...MANAGER_ROLES), async (req, res, next) => {
  try {
    const comment = typeof req.body?.comment === "string" ? req.body.comment.trim().slice(0, 2000) : "";
    const report = await prisma.report.update({
      where: { id: parseId(req.params.id) },
      data: { reviewedById: req.user.id, reviewedAt: new Date(), reviewComment: comment || null },
      include: REPORT_INCLUDE,
    });
    res.json(report);
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "not_found" });
    next(err);
  }
});

module.exports = router;
