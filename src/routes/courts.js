const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isManager } = require("../middleware/auth");
const { parseId } = require("../utils/params");
const { caseRole, EXTRA_LAWYERS } = require("../lib/clientAccess");
const { getSetting } = require("../lib/settings");
const { canUseClients } = require("./clients");
const dir = require("../services/courts/directory");
const sync = require("../services/courts/sync");

// Court hearings from sud.uz (services/courts/sync.js).
//
//   GET  /api/courts                  every court, for the court picker
//   GET  /api/courts/finds?caseId=    "is this our client?" questions waiting for me
//   POST /api/courts/finds/:id        { ours: true | false } — answer one
//   POST /api/courts/check/:caseId    read this case's courts now
//   GET  /api/courts/status           the last runs (managers)
//
// Who: as for a case's history — managers, its lawyers, its coordinator. A
// question on a case no longer signed or archived: 409 case_closed.

const router = express.Router();
router.use(requireAuth, (req, res, next) => (canUseClients(req.user) ? next() : res.status(403).json({ error: "forbidden" })));

router.get("/", (req, res) => {
  res.json({ courts: dir.all().map(dir.publicCourt) });
});

router.get("/finds", async (req, res, next) => {
  try {
    const caseId = req.query.caseId ? parseId(req.query.caseId) : null;
    res.json(await sync.waitingFor(req.user, { caseId }));
  } catch (err) {
    next(err);
  }
});

router.post("/finds/:id", async (req, res, next) => {
  try {
    if (typeof req.body?.ours !== "boolean") return res.status(400).json({ error: "ours must be true or false" });
    res.json(await sync.answer(parseId(req.params.id), req.user, req.body.ours));
  } catch (err) {
    if (err instanceof sync.FindError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Once a minute per case is plenty; a check reads up to a hundred lists.
const lastCheck = new Map();
const CHECK_EVERY_MS = 60 * 1000;
const WAIT_MS = 20 * 1000;

router.post("/check/:caseId", async (req, res, next) => {
  try {
    const caseId = parseId(req.params.caseId);
    const kase = await prisma.clientCase.findUnique({
      where: { id: caseId },
      select: { id: true, status: true, operatorId: true, coordinatorId: true, lawyerId: true, extraLawyers: EXTRA_LAWYERS, client: { select: { createdById: true, cases: { select: { operatorId: true } } } } },
    });
    const role = kase ? caseRole(req.user, kase, kase.client) : null;
    if (!role) return res.status(404).json({ error: "not_found" });
    if (!["manager", "lawyer", "coordinator"].includes(role)) return res.status(403).json({ error: "forbidden" });
    if (kase.status !== "contract") return res.status(400).json({ error: "not_signed" });
    if (Date.now() - (lastCheck.get(caseId) || 0) < CHECK_EVERY_MS) return res.status(429).json({ error: "too_soon" });
    lastCheck.set(caseId, Date.now());
    // Up to 20 seconds here (the portal waits 30); a longer one — a name
    // looked for in a whole region — goes on, and what it finds comes as a
    // notification.
    const job = sync.checkCase(caseId);
    job.catch((err) => console.error(`[courts] check of case ${caseId} failed:`, err.message));
    const summary = await Promise.race([job, new Promise((resolve) => setTimeout(() => resolve(null), WAIT_MS).unref())]);
    if (!summary) return res.status(202).json({ running: true });
    if (summary.busy) return res.status(409).json({ error: "busy" });
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

router.get("/status", async (req, res, next) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    const [status, asking] = await Promise.all([getSetting(sync.STATUS_KEY, {}), prisma.courtFind.count({ where: { state: "asking" } })]);
    res.json({ enabled: sync.enabled(), ...status, asking, pausedUntil: sync.pausedUntil() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
