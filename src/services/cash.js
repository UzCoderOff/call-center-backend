const prisma = require("../lib/prisma");
const { badRequest } = require("../utils/params");

// Cash in people's hands. A cash payment is with whoever took the money:
// the person it names (Payment.cashHolderId — an operator records the fee,
// the client pays the boss or the lawyer in the office), or else whoever
// recorded it. When they hand it over (to the boss / the firm's cash box)
// that's a CashHandover. What they hold = cash with them − handed over.
//
// Counted from CASH_TRACKING_FROM (default 2026-10-01, when this started) —
// cash taken before that was settled the old way and isn't anyone's balance.
// Cash with the boss or the developer is already with the firm (they are
// where it's handed to), so only staff and lawyers have balances.

const CASH_FROM = process.env.CASH_TRACKING_FROM || "2026-10-01";
const KASSA_ROLES = ["BOSS", "DEVELOPER"];

// Who has a cash payment's money.
const holderOf = (p) => p.cashHolderId ?? p.recordedById;

// Cash payments with these people (null: anyone's), counted ones only.
function heldWhere(userIds = null) {
  const who = userIds ? { in: userIds } : { not: null };
  return {
    method: "cash",
    date: { gte: CASH_FROM },
    OR: [{ cashHolderId: who }, { cashHolderId: null, recordedById: who }],
  };
}

// userIds: only these people (null: everyone with any cash). withKassa: also
// the boss's and the developer's rows (kassa: true) — cash that's already
// with the firm, listed so a payment put there by mistake can be found.
async function cashBalances({ userIds = null, withKassa = false } = {}) {
  const [cash, handed] = await Promise.all([
    prisma.payment.findMany({ where: heldWhere(userIds), select: { amount: true, recordedById: true, cashHolderId: true } }),
    prisma.cashHandover.groupBy({
      by: ["userId"],
      where: { date: { gte: CASH_FROM }, ...(userIds ? { userId: { in: userIds } } : {}) },
      _sum: { amount: true },
      _max: { date: true },
    }),
  ]);
  const taken = new Map(); // userId -> { sum, count }
  for (const p of cash) {
    const id = holderOf(p);
    const t = taken.get(id) || { sum: 0, count: 0 };
    t.sum += p.amount;
    t.count += 1;
    taken.set(id, t);
  }
  const ids = [...new Set([...taken.keys(), ...handed.map((h) => h.userId), ...(userIds || [])])].filter(Boolean);
  const users = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, name: true, role: true, employee: { select: { id: true, name: true } } } })
    : [];
  return users
    .map((u) => {
      const t = taken.get(u.id);
      const h = handed.find((x) => x.userId === u.id);
      const takenSum = t?.sum || 0;
      const handedSum = h?._sum.amount || 0;
      return {
        user: { id: u.id, name: u.employee?.name || u.name || u.username, role: u.role, employeeId: u.employee?.id ?? null },
        kassa: KASSA_ROLES.includes(u.role),
        taken: takenSum,
        payments: t?.count || 0,
        handed: handedSum,
        holding: takenSum - handedSum,
        lastHandover: h?._max.date || null,
      };
    })
    .filter((row) => withKassa || !row.kassa)
    .sort((a, b) => b.holding - a.holding || a.user.name.localeCompare(b.user.name));
}

// Who a cash payment can be with, for the forms' "Who took the money?":
// the boss and the lawyers (besides "me" — whoever records it). The
// developer only when they ask for everyone (managers fixing Kassa).
async function cashHolderChoices({ everyone = false } = {}, db = prisma) {
  const users = await db.user.findMany({
    where: { active: true, ...(everyone ? {} : { role: { in: ["BOSS", "LAWYER"] } }) },
    select: { id: true, username: true, name: true, role: true, employee: { select: { name: true, active: true } } },
  });
  const order = { BOSS: 0, LAWYER: 1, EMPLOYEE: 2, DEVELOPER: 3 };
  return users
    .filter((u) => !u.employee || u.employee.active)
    .map((u) => ({ id: u.id, name: u.employee?.name || u.name || u.username, role: u.role }))
    .sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.name.localeCompare(b.name));
}

// A request's "who took the cash" (`cashWith`: a user id; "me", null or ""
// for whoever recorded it) -> Payment.cashHolderId to store (null: the
// recorder). undefined when it isn't given. The forms offer the boss and
// the lawyers (cashHolderChoices); `any`: anyone working here (Kassa).
async function cashHolderId(value, recorderId, { any = false } = {}, db = prisma) {
  if (value === undefined) return undefined;
  if (value === null || value === "" || value === "me") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("invalid cashWith");
  if (id === recorderId) return null;
  const user = await db.user.findUnique({ where: { id }, select: { active: true, role: true, employee: { select: { active: true } } } });
  if (!user?.active || user.employee?.active === false) throw badRequest("invalid cashWith");
  if (!any && !["BOSS", "LAWYER"].includes(user.role)) throw badRequest("invalid cashWith");
  return id;
}

module.exports = { cashBalances, cashHolderChoices, cashHolderId, heldWhere, holderOf, CASH_FROM, KASSA_ROLES };
