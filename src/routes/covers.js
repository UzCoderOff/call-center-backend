const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isManager } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { firmNow, isValidDate, shiftDate } = require("../lib/firmTime");
const { LAWYER_ROLES, LAWYER_NAME, displayName, lawyerAccounts } = require("../lib/lawyers");
const { syncCovers } = require("../services/covers");

// Covers for a lawyer who is away (services/covers.js).
//
//   GET    /api/covers           the covers I'm in (as the one away or the one
//                                covering), running or ahead; managers: all
//   GET    /api/covers/lawyers   who can cover (lawyer accounts)
//   POST   /api/covers           { lawyerId?, coverId, from, to, note? } — a lawyer
//                                for themselves; managers for any lawyer
//   PATCH  /api/covers/:id       { to?, note? } or { end: true } — the one away,
//                                the one covering (end only), managers
const router = express.Router();
router.use(requireAuth);

const MAX_DAYS = 120;
const mayHaveCover = (user) => LAWYER_ROLES.includes(user.role);

function shape(c, today) {
  return {
    id: c.id,
    lawyer: { id: c.lawyer.id, name: displayName(c.lawyer) },
    cover: { id: c.cover.id, name: displayName(c.cover) },
    from: c.from,
    to: c.to,
    note: c.note,
    running: !c.endedAt && c.from <= today && today <= c.to,
    ended: Boolean(c.endedAt) || c.to < today,
    cases: c._count?.cases ?? 0,
  };
}
const INCLUDE = { lawyer: { select: LAWYER_NAME }, cover: { select: LAWYER_NAME }, _count: { select: { cases: true } } };

router.get("/", async (req, res, next) => {
  try {
    const today = firmNow().date;
    const mine = isManager(req.user) ? {} : { OR: [{ lawyerId: req.user.id }, { coverId: req.user.id }] };
    const rows = await prisma.lawyerCover.findMany({ where: { ...mine, endedAt: null, to: { gte: today } }, include: INCLUDE, orderBy: [{ from: "asc" }] });
    res.json({ today, covers: rows.map((c) => shape(c, today)) });
  } catch (err) {
    next(err);
  }
});

router.get("/lawyers", async (req, res, next) => {
  try {
    if (!mayHaveCover(req.user) && !isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    res.json(await lawyerAccounts());
  } catch (err) {
    next(err);
  }
});

async function lawyerAccount(id, field) {
  const user = await prisma.user.findUnique({ where: { id: parseId(id, field) }, select: { id: true, role: true, active: true } });
  if (!user || !user.active || !LAWYER_ROLES.includes(user.role)) throw badRequest(`invalid ${field}`);
  return user.id;
}

function period(from, to, today) {
  if (!isValidDate(from) || !isValidDate(to) || to < from) throw badRequest("invalid dates");
  if (to < today) throw badRequest("already over");
  if (to > shiftDate(from, MAX_DAYS)) throw badRequest("too long");
}

router.post("/", async (req, res, next) => {
  try {
    const b = req.body || {};
    const today = firmNow().date;
    const lawyerId = b.lawyerId != null && b.lawyerId !== "" ? await lawyerAccount(b.lawyerId, "lawyerId") : req.user.id;
    if (lawyerId !== req.user.id && !isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    if (!mayHaveCover({ role: lawyerId === req.user.id ? req.user.role : "LAWYER" })) return res.status(403).json({ error: "forbidden" });
    const coverId = await lawyerAccount(b.coverId, "coverId");
    if (coverId === lawyerId) throw badRequest("can't cover yourself");
    const from = String(b.from || today);
    const to = String(b.to || "");
    period(from, to, today);
    const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 300) : null;
    // One cover at a time for the same days.
    const overlap = await prisma.lawyerCover.findFirst({ where: { lawyerId, endedAt: null, from: { lte: to }, to: { gte: from } } });
    if (overlap) return res.status(409).json({ error: "overlaps" });
    const row = await prisma.lawyerCover.create({ data: { lawyerId, coverId, from, to, note, createdById: req.user.id }, include: INCLUDE });
    await syncCovers();
    const fresh = await prisma.lawyerCover.findUnique({ where: { id: row.id }, include: INCLUDE });
    res.status(201).json(shape(fresh, today));
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const today = firmNow().date;
    const row = await prisma.lawyerCover.findUnique({ where: { id: parseId(req.params.id) } });
    if (!row || row.endedAt) return res.status(404).json({ error: "not_found" });
    const manager = isManager(req.user);
    const away = row.lawyerId === req.user.id;
    const covering = row.coverId === req.user.id;
    if (!manager && !away && !covering) return res.status(404).json({ error: "not_found" });
    const b = req.body || {};
    let data;
    if (b.end === true) {
      data = { endedAt: new Date() };
    } else {
      if (!manager && !away) return res.status(403).json({ error: "forbidden" });
      data = {};
      if (row.to < today) return res.status(409).json({ error: "over" });
      if (b.to !== undefined) {
        period(row.from, String(b.to), today);
        const overlap = await prisma.lawyerCover.findFirst({ where: { id: { not: row.id }, lawyerId: row.lawyerId, endedAt: null, from: { lte: String(b.to) }, to: { gte: row.from } } });
        if (overlap) return res.status(409).json({ error: "overlaps" });
        data.to = String(b.to);
      }
      if (b.note !== undefined) data.note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 300) : null;
      if (Object.keys(data).length === 0) throw badRequest("nothing to change");
    }
    await prisma.lawyerCover.update({ where: { id: row.id }, data });
    await syncCovers();
    res.json(shape(await prisma.lawyerCover.findUnique({ where: { id: row.id }, include: INCLUDE }), today));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
