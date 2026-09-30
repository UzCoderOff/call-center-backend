const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isManager, isLawyer } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { firmDate } = require("../lib/firmTime");
const { canSeeFinance } = require("../lib/finance");
const { monthPerformance, history } = require("../services/performance");
const { cashBalances } = require("../services/cash");
const { buildWorkbook } = require("../lib/xlsx");
const { parseKey, formMeasures, catalogFor, targetsFor } = require("../services/performanceMetrics");

// Natijalar — each person's month at work (src/services/performance.js).
//
//   GET    /api/performance?month=YYYY-MM          everyone (managers) — or just yourself
//   GET    /api/performance/:employeeId?month=     one person: + day by day, six months
//   GET    /api/performance/:employeeId/costs      what they cost per month (Moliya)
//   PUT    /api/performance/:employeeId/costs      { fromMonth, amount, note? } (Moliya)
//   DELETE /api/performance/:employeeId/costs/:id  (Moliya)
//
// Managers see everyone; staff see only themselves (their own numbers, the
// consultation fees they took — no contract money, no cost). Contract money
// and cost need Moliya. Lawyers aren't staff members here.
const router = express.Router();
router.use(requireAuth, (req, res, next) => {
  if (isLawyer(req.user) || (!isManager(req.user) && !req.user.employee)) return res.status(403).json({ error: "forbidden" });
  next();
});

const EMPLOYEE_SELECT = {
  id: true,
  userId: true,
  name: true,
  active: true,
  createdAt: true,
  collectCalls: true,
  calendarAccess: true,
  workKind: true,
  autoReport: true,
  alsoForm: true,
  reportTemplateId: true,
  workDays: true,
  holidaysOff: true,
  office: { select: { name: true } },
  position: { select: { name: true, targetConsultations: true, targetContracts: true } },
};

function monthParam(value) {
  const current = firmDate().slice(0, 7);
  if (value === undefined || value === "") return current;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(value))) throw badRequest("invalid month");
  return String(value);
}

// Money beyond consultation fees: managers with Moliya.
const withMoney = (user) => isManager(user) && canSeeFinance(user);

router.get("/", async (req, res, next) => {
  try {
    const month = monthParam(req.query.month);
    const range = { gte: `${month}-01`, lte: `${month}-31` };
    const employees = await prisma.employee.findMany({
      where: isManager(req.user)
        ? {
            // Everyone working now, and anyone who left but did something that month.
            OR: [
              { active: true },
              { cases: { some: { OR: [{ consultationDate: range }, { contractDate: range }] } } },
              { user: { bookedAppointments: { some: { date: range } } } },
            ],
          }
        : { id: req.user.employee.id },
      select: EMPLOYEE_SELECT,
      orderBy: { name: "asc" },
    });
    const data = await monthPerformance({ month, employees, finance: withMoney(req.user) });
    res.json({ ...data, current: firmDate().slice(0, 7), finance: withMoney(req.user), mineOnly: !isManager(req.user) });
  } catch (err) {
    next(err);
  }
});

// The month as an Excel workbook (managers): the team table, every
// person's days, and their days away.
router.get("/export", async (req, res, next) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    const month = monthParam(req.query.month);
    const range = { gte: `${month}-01`, lte: `${month}-31` };
    const employees = await prisma.employee.findMany({
      where: {
        OR: [
          { active: true },
          { cases: { some: { OR: [{ consultationDate: range }, { contractDate: range }] } } },
          { user: { bookedAppointments: { some: { date: range } } } },
        ],
      },
      select: EMPLOYEE_SELECT,
      orderBy: { name: "asc" },
    });
    const finance = withMoney(req.user);
    const data = await monthPerformance({ month, employees, finance, detail: true });
    res.set("Content-Disposition", `attachment; filename="natijalar-${month}.xlsx"`);
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(buildWorkbook(performanceSheets(data, finance)));
  } catch (err) {
    next(err);
  }
});

const AWAY_NAME = { day_off: "Dam olish", sick: "Kasal", vacation: "Taʼtil", holiday: "Bayram" };

function performanceSheets(data, finance) {
  const team = [
    [
      "Xodim",
      "Lavozim",
      "Ish kunlari (jami)",
      "Oʻtgan ish kunlari",
      "Qoʻngʻiroqlar",
      "Javob berilgan",
      "Oʻtkazib yuborilgan",
      "Qayta bogʻlanildi",
      "Yozgan konsultatsiyalar",
      "Konsultatsiyalar",
      "Reja",
      "Bugungacha kerak",
      "Shartnomalar",
      "Reja",
      "Konversiya %",
      ...(finance ? ["Olib kelgan", "Oylik xarajati", "Qaytim (×)"] : ["Konsultatsiya toʻlovlari"]),
      "Qabul qilgan naqd",
      "Hisobot (topshirgan)",
      "Hisobot (kerak)",
      "Vazifalar (oʻz vaqtida)",
      "Vazifalar (jami)",
      "Dam olish/kasal/taʼtil kunlari",
    ],
  ];
  for (const r of data.rows) {
    team.push([
      r.employee.name,
      r.employee.position || "",
      r.workDays.total,
      r.workDays.soFar,
      r.calls ? r.calls.total : "",
      r.calls ? r.calls.answered : "",
      r.calls ? r.calls.missed : "",
      r.calls ? r.calls.reached : "",
      r.bookings.made,
      r.consultations.count,
      r.consultations.target ?? "",
      r.consultations.expected ?? "",
      r.contracts.count,
      r.contracts.target ?? "",
      r.conversion.rate ?? "",
      ...(finance ? [r.money.brought.total + (r.money.reportIncome || 0), r.cost?.amount ?? "", r.cost?.ratio ?? ""] : [r.money.brought.consultation]),
      r.money.taken.cash,
      r.reports.due ? r.reports.sent : "",
      r.reports.due || "",
      r.tasks.total ? r.tasks.onTime : "",
      r.tasks.total || "",
      r.workDays.away.filter((a) => a.kind !== "holiday").length,
    ]);
  }
  const days = [["Xodim", "Sana", "Javob berilgan", "Oʻtkazib yuborilgan", "Yozgan", "Konsultatsiyalar", "Shartnomalar", "Konsultatsiya toʻlovi", ...(finance ? ["Olib kelgan"] : [])]];
  for (const r of data.rows) {
    for (const d of r.days || []) {
      days.push([r.employee.name, d.date, d.answered, d.missed, d.booked, d.consultations, d.contracts, d.fees, ...(finance ? [d.brought] : [])]);
    }
  }
  const away = [["Xodim", "Sana", "Sabab"]];
  for (const r of data.rows) for (const a of r.workDays.away) away.push([r.employee.name, a.date, a.name ? `${AWAY_NAME[a.kind]}: ${a.name}` : AWAY_NAME[a.kind] || a.kind]);
  const plans = [["Xodim", "Nima", "Shakl", "Qilingani", "Reja", "Bugungacha kerak", "Bajarildi %"]];
  const BUILTIN_NAME = { consultations: "Konsultatsiyalar", contracts: "Shartnomalar", bookings: "Kalendarga yozgan", calls_answered: "Javob berilgan qoʻngʻiroqlar", fees: "Konsultatsiya toʻlovlari" };
  for (const r of data.rows) {
    for (const m of r.metrics) plans.push([r.employee.name, m.builtin ? BUILTIN_NAME[m.key] : m.label, m.form || "", m.value, m.target ?? "", m.expected ?? "", m.pct ?? ""]);
  }
  return [
    { name: "Rejalar", rows: plans, widths: [24, 34, 26, 12, 10, 16, 12] },
    { name: "Jamoa", rows: team, widths: [24, 22, ...team[0].slice(2).map(() => 14)] },
    { name: "Kunlar", rows: days, widths: [24, 12, 14, 16, 10, 16, 12, 18, 14] },
    { name: "Dam olish", rows: away, widths: [24, 12, 40] },
  ];
}

async function loadEmployee(req) {
  const id = parseId(req.params.employeeId, "employeeId");
  if (!isManager(req.user) && req.user.employee?.id !== id) {
    const err = new Error("not_found");
    err.status = 404;
    throw err;
  }
  const employee = await prisma.employee.findUnique({ where: { id }, select: EMPLOYEE_SELECT });
  if (!employee) {
    const err = new Error("not_found");
    err.status = 404;
    throw err;
  }
  return employee;
}

const sendError = (err, res, next) => (err.status ? res.status(err.status).json({ error: err.message }) : next(err));

router.get("/:employeeId", async (req, res, next) => {
  try {
    const month = monthParam(req.query.month);
    const employee = await loadEmployee(req);
    const finance = withMoney(req.user);
    const data = await monthPerformance({ month, employees: [employee], finance, detail: true });
    res.json({
      month,
      current: firmDate().slice(0, 7),
      today: data.today,
      workDays: data.workDays,
      workDaysSoFar: data.workDaysSoFar,
      finance,
      canSetCost: finance,
      ...data.rows[0],
      history: await history(employee, month, finance),
      // Cash in their hands now (Kassa).
      cash: employee.userId ? ((await cashBalances({ userIds: [employee.userId] }))[0] ?? { taken: 0, handed: 0, holding: 0 }) : null,
    });
  } catch (err) {
    sendError(err, res, next);
  }
});

// --------------------------------------------------------------- targets
// A person's targets: what they can be measured on (built-ins for client
// work, their report form's numbers), what's set for the month, and every
// entry (a target holds from its month until changed).
//
//   GET    /api/performance/:employeeId/targets?month=
//   PUT    /api/performance/:employeeId/targets   { metric, amount, fromMonth? } (managers; 0 = no target from then)
//   DELETE /api/performance/:employeeId/targets/:id (managers)
router.get("/:employeeId/targets", async (req, res, next) => {
  try {
    const employee = await loadEmployee(req);
    const month = monthParam(req.query.month);
    const [catalog, current, entries] = await Promise.all([
      catalogFor(employee),
      targetsFor([employee], month),
      prisma.target.findMany({ where: { employeeId: employee.id }, orderBy: [{ fromMonth: "desc" }, { id: "desc" }], include: { setBy: { select: { username: true, name: true } } } }),
    ]);
    res.json({
      month,
      canSet: isManager(req.user),
      catalog,
      current: [...current.get(employee.id)].map(([metric, amount]) => ({ metric, amount })),
      position: { consultations: employee.position?.targetConsultations ?? null, contracts: employee.position?.targetContracts ?? null },
      entries: entries.map((t) => ({ id: t.id, metric: t.metric, amount: t.amount, fromMonth: t.fromMonth, setBy: t.setBy ? t.setBy.name || t.setBy.username : null })),
    });
  } catch (err) {
    sendError(err, res, next);
  }
});

router.put("/:employeeId/targets", async (req, res, next) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    const employee = await loadEmployee(req);
    const b = req.body || {};
    const key = parseKey(b.metric);
    if (!key) throw badRequest("invalid metric");
    if (!key.builtin) {
      const template = await prisma.reportTemplate.findUnique({ where: { id: key.templateId }, select: { id: true, name: true, fields: true } });
      if (!template || !formMeasures(template).some((m) => m.key === b.metric)) throw badRequest("unknown metric");
    }
    const amount = Number(String(b.amount ?? "").replace(/[\s ]/g, ""));
    if (!Number.isInteger(amount) || amount < 0 || amount > 10_000_000_000) throw badRequest("invalid amount");
    const fromMonth = monthParam(b.fromMonth);
    const row = await prisma.target.upsert({
      where: { employeeId_metric_fromMonth: { employeeId: employee.id, metric: b.metric, fromMonth } },
      create: { employeeId: employee.id, metric: b.metric, amount, fromMonth, setById: req.user.id },
      update: { amount, setById: req.user.id },
    });
    res.json(row);
  } catch (err) {
    sendError(err, res, next);
  }
});

router.delete("/:employeeId/targets/:id", async (req, res, next) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    const employee = await loadEmployee(req);
    const row = await prisma.target.findFirst({ where: { id: parseId(req.params.id), employeeId: employee.id } });
    if (!row) return res.status(404).json({ error: "not_found" });
    await prisma.target.delete({ where: { id: row.id } });
    res.status(204).end();
  } catch (err) {
    sendError(err, res, next);
  }
});

// ------------------------------------------------------------------ cost
function financeOnly(req, res, next) {
  if (!withMoney(req.user)) return res.status(403).json({ error: "finance_forbidden" });
  next();
}

router.get("/:employeeId/costs", financeOnly, async (req, res, next) => {
  try {
    const employee = await loadEmployee(req);
    const rows = await prisma.employeeCost.findMany({
      where: { employeeId: employee.id },
      orderBy: { fromMonth: "desc" },
      include: { setBy: { select: { username: true, name: true } } },
    });
    res.json(rows);
  } catch (err) {
    sendError(err, res, next);
  }
});

router.put("/:employeeId/costs", financeOnly, async (req, res, next) => {
  try {
    const employee = await loadEmployee(req);
    const b = req.body || {};
    const fromMonth = monthParam(b.fromMonth);
    const amount = Number(String(b.amount ?? "").replace(/[\s ]/g, ""));
    if (!Number.isInteger(amount) || amount < 0 || amount > 10_000_000_000) throw badRequest("invalid amount");
    const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 200) : null;
    const row = await prisma.employeeCost.upsert({
      where: { employeeId_fromMonth: { employeeId: employee.id, fromMonth } },
      create: { employeeId: employee.id, fromMonth, amount, note, setById: req.user.id },
      update: { amount, note, setById: req.user.id },
    });
    await prisma.auditLog.create({ data: { userId: req.user.id, action: "employee.cost", entity: "employee", entityId: employee.id, detail: { fromMonth, amount } } });
    res.json(row);
  } catch (err) {
    sendError(err, res, next);
  }
});

router.delete("/:employeeId/costs/:id", financeOnly, async (req, res, next) => {
  try {
    const employee = await loadEmployee(req);
    const id = parseId(req.params.id);
    const row = await prisma.employeeCost.findFirst({ where: { id, employeeId: employee.id } });
    if (!row) return res.status(404).json({ error: "not_found" });
    await prisma.employeeCost.delete({ where: { id } });
    await prisma.auditLog.create({ data: { userId: req.user.id, action: "employee.cost.delete", entity: "employee", entityId: employee.id, detail: { fromMonth: row.fromMonth, amount: row.amount } } });
    res.status(204).end();
  } catch (err) {
    sendError(err, res, next);
  }
});

module.exports = router;
