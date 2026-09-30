const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isManager } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { firmDate, isValidDate } = require("../lib/firmTime");
const { canSeeFinance } = require("../lib/finance");
const { cashBalances, CASH_FROM } = require("../services/cash");

// Kassa — cash in people's hands (src/services/cash.js).
//
//   GET    /api/cash                everyone's balance + recent handovers (managers with Moliya)
//   GET    /api/cash/me             your own balance
//   POST   /api/cash/handovers      { userId, amount, date?, note? } — "received from" (managers with Moliya)
//   DELETE /api/cash/handovers/:id  (managers with Moliya)
const router = express.Router();
router.use(requireAuth);
const kassa = (req, res, next) => (isManager(req.user) && canSeeFinance(req.user) ? next() : res.status(403).json({ error: "finance_forbidden" }));
const PERSON = { select: { id: true, username: true, name: true, employee: { select: { name: true } } } };
const nameOf = (u) => (u ? u.employee?.name || u.name || u.username : null);
const shape = (h) => ({ id: h.id, date: h.date, amount: h.amount, note: h.note, user: { id: h.user.id, name: nameOf(h.user) }, receivedBy: nameOf(h.receivedBy), createdAt: h.createdAt });

router.get("/", kassa, async (req, res, next) => {
  try {
    const [people, recent] = await Promise.all([
      cashBalances(),
      prisma.cashHandover.findMany({ where: { date: { gte: CASH_FROM } }, orderBy: [{ date: "desc" }, { id: "desc" }], take: 100, include: { user: PERSON, receivedBy: PERSON } }),
    ]);
    res.json({ from: CASH_FROM, today: firmDate(), people, handovers: recent.map(shape) });
  } catch (err) {
    next(err);
  }
});

router.get("/me", async (req, res, next) => {
  try {
    const [mine] = await cashBalances({ userIds: [req.user.id] });
    const recent = await prisma.cashHandover.findMany({
      where: { userId: req.user.id, date: { gte: CASH_FROM } },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      take: 10,
      include: { user: PERSON, receivedBy: PERSON },
    });
    res.json({ from: CASH_FROM, ...(mine || { taken: 0, handed: 0, holding: 0, payments: 0 }), handovers: recent.map(shape) });
  } catch (err) {
    next(err);
  }
});

router.post("/handovers", kassa, async (req, res, next) => {
  try {
    const b = req.body || {};
    const userId = parseId(b.userId, "userId");
    const amount = Number(String(b.amount ?? "").replace(/[\s ]/g, ""));
    if (!Number.isInteger(amount) || amount <= 0 || amount > 10_000_000_000) throw badRequest("invalid amount");
    const date = b.date === undefined || b.date === "" ? firmDate() : String(b.date);
    if (!isValidDate(date) || date > firmDate()) throw badRequest("invalid date");
    if (date < CASH_FROM) throw badRequest("before cash tracking started");
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw badRequest("unknown user");
    const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 200) : null;
    const row = await prisma.cashHandover.create({ data: { userId, amount, date, note, receivedById: req.user.id }, include: { user: PERSON, receivedBy: PERSON } });
    res.status(201).json(shape(row));
  } catch (err) {
    next(err);
  }
});

router.delete("/handovers/:id", kassa, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const row = await prisma.cashHandover.findUnique({ where: { id } });
    if (!row) return res.status(404).json({ error: "not_found" });
    await prisma.$transaction([
      prisma.auditLog.create({ data: { userId: req.user.id, action: "cash.handover.delete", entity: "cashHandover", entityId: id, detail: { userId: row.userId, amount: row.amount, date: row.date } } }),
      prisma.cashHandover.delete({ where: { id } }),
    ]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
