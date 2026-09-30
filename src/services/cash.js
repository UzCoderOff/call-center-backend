const prisma = require("../lib/prisma");

// Cash in people's hands. Whoever records a cash payment in Ledger took the
// money; when they hand it over (to the boss / the firm's cash box) that's a
// CashHandover. What they hold = cash payments they recorded − handed over.
//
// Counted from CASH_TRACKING_FROM (default 2026-10-01, when this started) —
// cash taken before that was settled the old way and isn't anyone's balance.
// Cash the boss or the developer records themselves is already with the
// firm (they are where it's handed to), so only staff have balances.

const CASH_FROM = process.env.CASH_TRACKING_FROM || "2026-10-01";
const KASSA_ROLES = ["BOSS", "DEVELOPER"];

// userIds: only these people (null: everyone with any cash).
async function cashBalances({ userIds = null } = {}) {
  const who = userIds ? { in: userIds } : undefined;
  const [taken, handed] = await Promise.all([
    prisma.payment.groupBy({
      by: ["recordedById"],
      where: { method: "cash", date: { gte: CASH_FROM }, recordedById: who ?? { not: null } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.cashHandover.groupBy({
      by: ["userId"],
      where: { date: { gte: CASH_FROM }, ...(who ? { userId: who } : {}) },
      _sum: { amount: true },
      _max: { date: true },
    }),
  ]);
  const ids = [...new Set([...taken.map((t) => t.recordedById), ...handed.map((h) => h.userId), ...(userIds || [])])].filter(Boolean);
  const users = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, name: true, role: true, employee: { select: { id: true, name: true } } } })
    : [];
  return users
    .map((u) => {
      const t = taken.find((x) => x.recordedById === u.id);
      const h = handed.find((x) => x.userId === u.id);
      const takenSum = t?._sum.amount || 0;
      const handedSum = h?._sum.amount || 0;
      return {
        user: { id: u.id, name: u.employee?.name || u.name || u.username, role: u.role, employeeId: u.employee?.id ?? null },
        taken: takenSum,
        payments: t?._count._all || 0,
        handed: handedSum,
        holding: takenSum - handedSum,
        lastHandover: h?._max.date || null,
      };
    })
    .filter((row) => !KASSA_ROLES.includes(row.user.role))
    .sort((a, b) => b.holding - a.holding || a.user.name.localeCompare(b.user.name));
}

module.exports = { cashBalances, CASH_FROM };
