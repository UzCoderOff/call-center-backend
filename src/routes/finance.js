const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isLawyer, isManager } = require("../middleware/auth");
const { buildWorkbook } = require("../lib/xlsx");
const { cashBalances } = require("../services/cash");
const { financeSheets } = require("../services/financeExport");
const { badRequest } = require("../utils/params");
const { firmNow, firmDayRange } = require("../lib/firmTime");
const { canSeeFinance } = require("../lib/finance");
const { DEFAULT_FEE } = require("../services/consultationFee");
const { reportMoney } = require("../services/reportMoney");
const { buildFinance, shiftMonth, monthOf } = require("../services/financeReport");

// The firm's money at a glance — only for the DEVELOPER and accounts with the
// "Moliya" switch (src/lib/finance.js).
//
//   GET /api/finance?month=YYYY-MM
//     summary        income (clients + reports), expenses, net, contracted,
//                    owed — and last month's, to compare
//     sources        where the money came from: client payments by kind (and
//                    new contracts vs. earlier ones), report money by
//                    question/service, by payment method, by person, by day
//     consultations  that month's appointments: held, paid, not paid, online,
//                    who came and then signed a contract, per lawyer
//     contracts      contracts signed that month, paid so far, remaining
//     owed           what clients still owe, by how old the contract is, and
//                    who owes most
//     lawyers        per lawyer: signed, received, owed, consultations
//     trend          the last six months
//     payments       that month's client payments; reportEntries: its report money
//
// How each figure is counted: src/services/financeReport.js. A lawyer with
// the switch sees the same for their own cases and calendar only, without
// report money (staff reports aren't theirs).
const router = express.Router();
router.use(requireAuth, (req, res, next) => {
  if (!canSeeFinance(req.user)) return res.status(403).json({ error: "finance_forbidden" });
  next();
});

const range = (from, to) => ({ gte: `${from}-01`, lte: `${to}-31` });
// "2026-09" -> "2026-09-30".
function lastDayOf(month) {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

// Everything the page shows for a month (also what the Excel export holds).
async function financeData(user, monthParam) {
  const today = firmNow().date;
  const current = monthOf(today);
  const month = monthParam === undefined ? current : String(monthParam);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest("invalid month");

  const lawyer = isLawyer(user);
  const caseScope = lawyer ? { lawyerId: user.id } : {};
  const paymentScope = lawyer ? { OR: [{ case: { lawyerId: user.id } }, { appointment: { calendar: { ownerId: user.id } } }] } : {};
  const firstMonth = shiftMonth(month, -5);

  const [payments, trendPayments, cases, appointments, reports, templates] = await Promise.all([
    prisma.payment.findMany({
      where: { date: range(month, month), ...paymentScope },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      include: {
        client: { select: { id: true, name: true, source: true } },
        case: { select: { id: true, matter: true, lawyer: true, lawyerId: true, contractDate: true } },
        recordedBy: { select: { username: true, name: true, employee: { select: { name: true } } } },
        appointment: { select: { format: true, calendar: { select: { ownerId: true } } } },
      },
    }),
    prisma.payment.findMany({
      where: { date: range(firstMonth, month), ...paymentScope },
      select: { date: true, amount: true, kind: true },
    }),
    prisma.clientCase.findMany({
      where: { contractAmount: { gt: 0 }, ...caseScope },
      select: {
        id: true,
        contractAmount: true,
        contractDate: true,
        lawyer: true,
        lawyerId: true,
        matter: true,
        client: { select: { id: true, name: true, archivedAt: true, source: true } },
        payments: { select: { amount: true, date: true, kind: true } },
        installments: { select: { id: true, dueDate: true, amount: true, note: true } },
      },
    }),
    prisma.appointment.findMany({
      where: { date: range(month, month), ...(lawyer ? { calendar: { ownerId: user.id } } : {}) },
      select: {
        id: true,
        date: true,
        start: true,
        status: true,
        format: true,
        clientId: true,
        clientName: true,
        calendar: { select: { name: true, ownerId: true } },
        payments: { where: { kind: "consultation" }, select: { amount: true } },
      },
    }),
    // Report money: not in a lawyer's view.
    lawyer
      ? []
      : prisma.report.findMany({
          where: { date: range(firstMonth, month) },
          select: { id: true, date: true, templateId: true, employeeId: true, fields: true, answers: true, employee: { select: { name: true } }, template: { select: { name: true } } },
        }),
    lawyer ? [] : prisma.reportTemplate.findMany({ select: { id: true, name: true, fields: true } }),
  ]);

  // Where clients come from (Client.source): new clients and this month's
  // consultations by source — the firm's view only.
  const [newClients, consultCases] = lawyer
    ? [[], []]
    : await Promise.all([
        prisma.client.findMany({
          where: { createdAt: { gte: new Date(firmDayRange(`${month}-01`).from), lte: new Date(firmDayRange(lastDayOf(month)).to) } },
          select: { source: true },
        }),
        prisma.clientCase.findMany({ where: { consultationDate: range(month, month) }, select: { client: { select: { source: true } } } }),
      ]);

  // Who came to a consultation this month and signed a contract after.
  const attendedIds = [...new Set(appointments.filter((a) => a.status === "attended" && a.clientId).map((a) => a.clientId))];
  const signed = attendedIds.length
    ? await prisma.clientCase.findMany({ where: { clientId: { in: attendedIds }, contractDate: { not: null } }, select: { clientId: true, contractDate: true } })
    : [];
  const contractDates = new Map();
  for (const k of signed) contractDates.set(k.clientId, [...(contractDates.get(k.clientId) || []), k.contractDate]);

  // Lawyers' names (cases and calendars point at their accounts).
  const lawyerIds = [...new Set([...cases.map((k) => k.lawyerId), ...payments.map((p) => p.case?.lawyerId), ...appointments.map((a) => a.calendar.ownerId)].filter(Boolean))];
  const users = lawyerIds.length ? await prisma.user.findMany({ where: { id: { in: lawyerIds } }, select: { id: true, name: true, username: true } }) : [];
  const names = new Map(users.map((u) => [u.id, u.name || u.username]));

  const monthReports = reports.filter((r) => monthOf(r.date) === month);
  const data = buildFinance({
    month,
    today,
    fee: DEFAULT_FEE,
    payments: payments.map((p) => ({
      id: p.id,
      date: p.date,
      amount: p.amount,
      kind: p.kind,
      method: p.method,
      note: p.note,
      client: p.client,
      case: p.case,
      recordedBy: p.recordedBy ? p.recordedBy.employee?.name || p.recordedBy.name || p.recordedBy.username : null,
      appointment: p.appointment ? { format: p.appointment.format, ownerId: p.appointment.calendar?.ownerId ?? null } : null,
    })),
    trendPayments,
    cases,
    appointments: appointments.map((a) => ({
      id: a.id,
      date: a.date,
      start: a.start,
      status: a.status,
      format: a.format,
      clientId: a.clientId,
      clientName: a.clientName,
      ownerId: a.calendar.ownerId,
      calendarName: a.calendar.name,
      paid: a.payments.length ? { amount: a.payments.reduce((s, p) => s + p.amount, 0) } : null,
    })),
    contractDates,
    report: lawyer ? null : reportMoney(monthReports, templates),
    reportTrend: lawyer ? [] : reportMoney(reports, templates).entries,
    names,
    channels: lawyer ? null : { newClients: newClients.map((c) => c.source), consultations: consultCases.map((k) => k.client.source) },
  });

  return { month, current, today, scope: lawyer ? "lawyer" : "firm", ...data };
}

router.get("/", async (req, res, next) => {
  try {
    res.json(await financeData(req.user, req.query.month));
  } catch (err) {
    next(err);
  }
});

router.get("/export", async (req, res, next) => {
  try {
    const data = await financeData(req.user, req.query.month);
    const cash = isManager(req.user) ? await cashBalances() : null;
    const file = buildWorkbook(financeSheets(data, cash));
    res.set("Content-Disposition", `attachment; filename="moliya-${data.month}.xlsx"`);
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(file);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
