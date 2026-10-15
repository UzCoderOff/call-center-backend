const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isManager } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { firmDate, isValidDate } = require("../lib/firmTime");
const { canSeeFinance } = require("../lib/finance");
const { cashBalances, cashHolderChoices, cashHolderId, heldWhere, holderOf, CASH_FROM } = require("../services/cash");

// Kassa — cash in people's hands (src/services/cash.js).
//
//   GET    /api/cash                everyone's balance + recent handovers (managers with Moliya)
//   GET    /api/cash/me             your own balance
//   POST   /api/cash/handovers      { userId, amount, date?, note? } — "received from" (managers with Moliya)
//   DELETE /api/cash/handovers/:id  (managers with Moliya)
//   GET    /api/cash/holders        who can take cash, for the forms' "Who took it?" (?everyone=1: anyone, managers with Moliya)
//   GET    /api/cash/payments?userId=  the cash payments with one person (managers with Moliya)
//   PATCH  /api/cash/payments/:id   { cashWith } — who really took it (managers with Moliya)
const router = express.Router();
router.use(requireAuth);
const kassa = (req, res, next) => (isManager(req.user) && canSeeFinance(req.user) ? next() : res.status(403).json({ error: "finance_forbidden" }));
const PERSON = { select: { id: true, username: true, name: true, employee: { select: { name: true } } } };
const nameOf = (u) => (u ? u.employee?.name || u.name || u.username : null);
const shape = (h) => ({ id: h.id, date: h.date, amount: h.amount, note: h.note, user: { id: h.user.id, name: nameOf(h.user) }, receivedBy: nameOf(h.receivedBy), createdAt: h.createdAt });

router.get("/", kassa, async (req, res, next) => {
  try {
    const [everyone, recent] = await Promise.all([
      cashBalances({ withKassa: true }),
      prisma.cashHandover.findMany({ where: { date: { gte: CASH_FROM } }, orderBy: [{ date: "desc" }, { id: "desc" }], take: 100, include: { user: PERSON, receivedBy: PERSON } }),
    ]);
    res.json({
      from: CASH_FROM,
      today: firmDate(),
      people: everyone.filter((p) => !p.kassa),
      // Cash with the boss or the developer: already with the firm.
      kassa: everyone.filter((p) => p.kassa && p.payments > 0),
      handovers: recent.map(shape),
    });
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

router.get("/holders", async (req, res, next) => {
  try {
    const everyone = req.query.everyone === "1" && isManager(req.user) && canSeeFinance(req.user);
    res.json({ me: req.user.id, people: await cashHolderChoices({ everyone }) });
  } catch (err) {
    next(err);
  }
});

// One person's cash (Kassa → their row): each cash payment counted with
// them, newest first, so a wrong one can be moved to whoever really took it.
const CASH_PAYMENT = {
  id: true,
  amount: true,
  date: true,
  kind: true,
  note: true,
  recordedById: true,
  cashHolderId: true,
  client: { select: { id: true, name: true } },
  recordedBy: PERSON,
  cashHolder: PERSON,
};
const cashPayment = (p) => ({
  id: p.id,
  amount: p.amount,
  date: p.date,
  kind: p.kind,
  note: p.note,
  client: p.client,
  recordedBy: p.recordedBy ? { id: p.recordedBy.id, name: nameOf(p.recordedBy) } : null,
  holder: { id: holderOf(p), name: nameOf(p.cashHolder || p.recordedBy) },
});

router.get("/payments", kassa, async (req, res, next) => {
  try {
    const userId = parseId(req.query.userId, "userId");
    const rows = await prisma.payment.findMany({ where: heldWhere([userId]), orderBy: [{ date: "desc" }, { id: "desc" }], take: 300, select: CASH_PAYMENT });
    res.json({ from: CASH_FROM, payments: rows.map(cashPayment) });
  } catch (err) {
    next(err);
  }
});

router.patch("/payments/:id", kassa, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const payment = await prisma.payment.findUnique({ where: { id }, select: { id: true, clientId: true, method: true, amount: true, date: true, recordedById: true, cashHolderId: true } });
    if (!payment) return res.status(404).json({ error: "not_found" });
    if (payment.method !== "cash") throw badRequest("not a cash payment");
    const cashWith = (req.body || {}).cashWith;
    if (cashWith === undefined) throw badRequest("cashWith is required");
    const holder = await cashHolderId(cashWith, payment.recordedById, { any: true });
    if (holder === payment.cashHolderId) return res.json(cashPayment(await prisma.payment.findUnique({ where: { id }, select: CASH_PAYMENT })));
    const row = await prisma.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: { userId: req.user.id, action: "payment.cashHolder", entity: "payment", entityId: id, detail: { clientId: payment.clientId, amount: payment.amount, date: payment.date, from: holderOf(payment), to: holder ?? payment.recordedById } },
      });
      return tx.payment.update({ where: { id }, data: { cashHolderId: holder, editedAt: new Date() }, select: CASH_PAYMENT });
    });
    res.json(cashPayment(row));
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
