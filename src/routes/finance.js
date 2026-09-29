const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isLawyer } = require("../middleware/auth");
const { badRequest } = require("../utils/params");
const { firmNow } = require("../lib/firmTime");
const { canSeeFinance } = require("../lib/finance");
const cl = require("../services/clients");

// The firm's money from clients at a glance — only for the DEVELOPER and
// accounts with the "Moliya" switch (src/lib/finance.js).
//
//   GET /api/finance?month=YYYY-MM
//     received    payments that month: total, count, by kind and by method
//     contracted  contracts signed that month: count and total amount
//     owed        what clients still owe on all contracts, and who owes most
//     lawyers     per lawyer: signed and received that month, still owed
//     trend       the last six months: received and contracted
//     payments    that month's payments, newest first
//
// A lawyer with the switch sees the same for their own cases only.
const router = express.Router();
router.use(requireAuth, (req, res, next) => {
  if (!canSeeFinance(req.user)) return res.status(403).json({ error: "finance_forbidden" });
  next();
});

const monthOf = (date) => date.slice(0, 7);
function shiftMonth(month, by) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}
const range = (month) => ({ gte: `${month}-01`, lte: `${month}-31` });

router.get("/", async (req, res, next) => {
  try {
    const current = monthOf(firmNow().date);
    const month = req.query.month === undefined ? current : String(req.query.month);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest("invalid month");

    // A lawyer: their own cases (and payments on them) only.
    const caseScope = isLawyer(req.user) ? { lawyerId: req.user.id } : {};
    const paymentScope = isLawyer(req.user) ? { case: { lawyerId: req.user.id } } : {};
    const firstMonth = shiftMonth(month, -5);

    const [payments, trendPayments, cases] = await Promise.all([
      prisma.payment.findMany({
        where: { date: range(month), ...paymentScope },
        orderBy: [{ date: "desc" }, { id: "desc" }],
        include: {
          client: { select: { id: true, name: true } },
          case: { select: { id: true, matter: true, lawyer: true } },
          recordedBy: { select: { username: true, name: true, employee: { select: { name: true } } } },
        },
      }),
      prisma.payment.findMany({
        where: { date: { gte: `${firstMonth}-01`, lte: `${month}-31` }, ...paymentScope },
        select: { date: true, amount: true },
      }),
      prisma.clientCase.findMany({
        where: { contractAmount: { gt: 0 }, ...caseScope },
        select: {
          id: true,
          contractAmount: true,
          contractDate: true,
          lawyer: true,
          matter: true,
          client: { select: { id: true, name: true, archivedAt: true } },
          payments: { select: { amount: true, date: true } },
        },
      }),
    ]);

    // Received this month.
    const byKind = {};
    const byMethod = {};
    let received = 0;
    for (const p of payments) {
      received += p.amount;
      byKind[p.kind || "other"] = (byKind[p.kind || "other"] || 0) + p.amount;
      byMethod[p.method || "none"] = (byMethod[p.method || "none"] || 0) + p.amount;
    }

    // Contracts signed this month, what's owed, and per lawyer.
    const lawyers = new Map();
    const lawyerRow = (name) => {
      const key = name || "";
      if (!lawyers.has(key)) lawyers.set(key, { lawyer: name || null, contracts: 0, contracted: 0, received: 0, owed: 0 });
      return lawyers.get(key);
    };
    const owedBy = new Map();
    let contracted = 0;
    let contractCount = 0;
    let owed = 0;
    for (const k of cases) {
      const row = lawyerRow(k.lawyer);
      if (k.contractDate && monthOf(k.contractDate) === month) {
        contracted += k.contractAmount;
        contractCount += 1;
        row.contracts += 1;
        row.contracted += k.contractAmount;
      }
      const { remaining } = cl.paymentSummary(k.contractAmount, k.payments);
      if (remaining > 0) {
        owed += remaining;
        row.owed += remaining;
        const c = owedBy.get(k.client.id) || { client: { id: k.client.id, name: k.client.name, archived: Boolean(k.client.archivedAt) }, owed: 0, lawyers: new Set() };
        c.owed += remaining;
        if (k.lawyer) c.lawyers.add(k.lawyer);
        owedBy.set(k.client.id, c);
      }
    }
    for (const p of payments) if (p.case) lawyerRow(p.case.lawyer).received += p.amount;

    const trend = [];
    for (let i = 0; i < 6; i++) trend.push({ month: shiftMonth(firstMonth, i), received: 0, contracted: 0 });
    for (const p of trendPayments) {
      const t = trend.find((x) => x.month === monthOf(p.date));
      if (t) t.received += p.amount;
    }
    for (const k of cases) {
      const t = k.contractDate && trend.find((x) => x.month === monthOf(k.contractDate));
      if (t) t.contracted += k.contractAmount;
    }

    res.json({
      month,
      current,
      received: { total: received, count: payments.length, byKind, byMethod },
      contracted: { total: contracted, count: contractCount },
      owed: {
        total: owed,
        clients: owedBy.size,
        top: [...owedBy.values()]
          .sort((a, b) => b.owed - a.owed)
          .slice(0, 20)
          .map((c) => ({ ...c, lawyers: [...c.lawyers] })),
      },
      lawyers: [...lawyers.values()].filter((r) => r.contracted || r.received || r.owed).sort((a, b) => b.contracted + b.received - (a.contracted + a.received) || b.owed - a.owed),
      trend,
      payments: payments.slice(0, 200).map((p) => ({
        id: p.id,
        date: p.date,
        amount: p.amount,
        kind: p.kind,
        method: p.method,
        note: p.note,
        client: p.client,
        matter: p.case?.matter ?? null,
        lawyer: p.case?.lawyer ?? null,
        recordedBy: p.recordedBy ? p.recordedBy.employee?.name || p.recordedBy.name || p.recordedBy.username : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
