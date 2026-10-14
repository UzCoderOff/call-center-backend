const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isManager } = require("../middleware/auth");
const { parseId } = require("../utils/params");
const { clientScope } = require("../lib/clientAccess");

// Ledger AI's suggestions about clients (services/ai/reports.js):
//
//   GET   /api/ai-suggestions?scope=mine|team   open ones for me (team:
//                                               managers, everyone's)
//   PATCH /api/ai-suggestions/:id               { done: true } | { dismissed: true }
//   POST  /api/ai-suggestions/run               managers: a new look now
//
// Someone sees only suggestions about clients they may see.
const router = express.Router();
router.use(requireAuth);

const PERSON = { select: { id: true, username: true, name: true, employee: { select: { name: true } } } };

router.get("/", async (req, res, next) => {
  try {
    const team = req.query.scope === "team" && isManager(req.user);
    const rows = await prisma.aiSuggestion.findMany({
      where: {
        doneAt: null,
        dismissedAt: null,
        AND: [
          team ? {} : isManager(req.user) ? { OR: [{ forUserId: req.user.id }, { forUserId: null }] } : { forUserId: req.user.id },
          { OR: [{ clientId: null }, { client: { archivedAt: null, ...clientScope(req.user) } }] },
        ],
      },
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
      take: 100,
      include: { client: { select: { id: true, name: true } }, forUser: PERSON },
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const row = await prisma.aiSuggestion.findUnique({ where: { id: parseId(req.params.id) } });
    if (!row || (row.forUserId !== req.user.id && !isManager(req.user))) return res.status(404).json({ error: "not_found" });
    const data = req.body?.done ? { doneAt: new Date() } : req.body?.dismissed ? { dismissedAt: new Date() } : null;
    if (!data) return res.status(400).json({ error: "done or dismissed" });
    res.json(await prisma.aiSuggestion.update({ where: { id: row.id }, data }));
  } catch (err) {
    next(err);
  }
});

router.post("/run", async (req, res, next) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    res.json(await require("../services/ai/reports").suggestions({ force: true }));
  } catch (err) {
    if (err.code === "claude_off" || err.code === "claude_cap") return res.status(409).json({ error: err.code });
    next(err);
  }
});

// Which of Claude's features are on — the portal shows their buttons only
// then (GET /api/ai-features).
const features = express.Router();
features.use(requireAuth);
features.get("/", async (req, res, next) => {
  try {
    const { claudeFeatureOn } = require("../services/ai/settings");
    const on = async (f) => claudeFeatureOn(f);
    res.json({ fileReader: await on("fileReader"), summaryDraft: await on("summaryDraft"), suggestions: await on("suggestions") });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.features = features;
