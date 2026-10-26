const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isManager } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { firmDayRange, firmNow } = require("../lib/firmTime");
const practice = require("../services/practice");
const { SCENARIOS, publicScenario } = require("../services/practice/scenarios");

// Practice with a made-up client the AI plays (services/practice).
//
//   GET  /api/practice                 the scenarios, my last tries; managers: the team this month
//   POST /api/practice                 { scenario } — start
//   GET  /api/practice/:id             one try (mine; managers: anyone's)
//   POST /api/practice/:id/say         { text } — my answer; the client replies (scored when it ends)
//   POST /api/practice/:id/finish      stop and score
//   GET  /api/practice/person/:employeeId?month=  someone's month (Natijalar): managers, or their own
//
// Managers practise any time; staff (anyone with an employee record) once a
// manager has switched practice on (Sozlamalar → Claude → Mashq).

const router = express.Router();
router.use(requireAuth);

const forbidden = () => Object.assign(new Error("forbidden"), { status: 403 });
const canPractise = async (user) => isManager(user) || (Boolean(user.employee) && (await practice.featureOn()));
const USER_REF = { select: { id: true, name: true, username: true, employee: { select: { id: true, name: true } } } };

function monthRange(month) {
  const m = /^\d{4}-\d{2}$/.test(String(month || "")) ? month : firmNow().date.slice(0, 7);
  const [y, mm] = m.split("-").map(Number);
  const next = `${mm === 12 ? y + 1 : y}-${String(mm === 12 ? 1 : mm + 1).padStart(2, "0")}-01`;
  return { month: m, from: new Date(firmDayRange(`${m}-01`).from), to: new Date(firmDayRange(next).from) };
}

// A practice error, said as the code (the portal words it).
function handle(err, res, next) {
  if (err instanceof practice.PracticeError) return res.status(err.status).json({ error: err.code });
  const claude = require("../services/ai/claude");
  if (err instanceof claude.ClaudeError || err?.status === 401 || /credit balance/i.test(err?.message || "")) {
    return res.status(409).json({ error: "ai_failed", message: claude.explain(err) });
  }
  next(err);
}

router.get("/", async (req, res, next) => {
  try {
    if (!(await canPractise(req.user))) throw forbidden();
    const mine = await prisma.practiceSession.findMany({ where: { userId: req.user.id }, orderBy: { id: "desc" }, take: 30 });
    const best = {};
    const tries = {};
    for (const r of mine) {
      tries[r.scenario] = (tries[r.scenario] || 0) + 1;
      if (r.score != null && (best[r.scenario] == null || r.score > best[r.scenario])) best[r.scenario] = r.score;
    }
    let team = null;
    if (isManager(req.user)) {
      const { month, from, to } = monthRange(req.query.month);
      const rows = await prisma.practiceSession.findMany({ where: { createdAt: { gte: from, lt: to } }, include: { user: USER_REF }, orderBy: { id: "desc" } });
      const byUser = new Map();
      for (const r of rows) {
        if (!byUser.has(r.userId)) byUser.set(r.userId, { user: r.user, rows: [] });
        byUser.get(r.userId).rows.push(r);
      }
      team = {
        month,
        people: [...byUser.values()].map(({ user, rows: list }) => ({
          user: { id: user.id, name: user.employee?.name || user.name || user.username, employeeId: user.employee?.id ?? null },
          ...practice.summarize(list),
          last: list.slice(0, 5).map((r) => ({ id: r.id, scenario: r.scenario, score: r.score, outcome: r.outcome, at: r.createdAt })),
        })),
      };
    }
    res.json({
      on: await practice.featureOn(),
      scenarios: SCENARIOS.map((s) => ({ ...publicScenario(s), best: best[s.id] ?? null, tries: tries[s.id] || 0 })),
      mine: mine.map((r) => ({ id: r.id, scenario: r.scenario, status: r.status, outcome: r.outcome, score: r.score, at: r.createdAt })),
      team,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    if (!(await canPractise(req.user))) throw forbidden();
    res.status(201).json(await practice.start(req.user, String(req.body?.scenario || "")));
  } catch (err) {
    handle(err, res, next);
  }
});

router.get("/person/:employeeId", async (req, res, next) => {
  try {
    const employeeId = parseId(req.params.employeeId, "employeeId");
    if (!isManager(req.user) && req.user.employee?.id !== employeeId) throw forbidden();
    const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { userId: true } });
    if (!employee?.userId) return res.json({ sessions: 0, averageScore: null, bestScore: null, outcomes: {}, last: [] });
    const { month, from, to } = monthRange(req.query.month);
    const rows = await prisma.practiceSession.findMany({ where: { userId: employee.userId, createdAt: { gte: from, lt: to } }, orderBy: { id: "desc" } });
    res.json({ month, ...practice.summarize(rows), last: rows.filter((r) => r.status === "done").slice(0, 10).map((r) => ({ id: r.id, scenario: r.scenario, score: r.score, outcome: r.outcome, at: r.createdAt })) });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const row = await practice.load(req.user, parseId(req.params.id), { manage: isManager(req.user) });
    res.json(practice.sessionLine(row, { withUser: true }));
  } catch (err) {
    handle(err, res, next);
  }
});

router.post("/:id/say", async (req, res, next) => {
  try {
    if (typeof req.body?.text !== "string") throw badRequest("text is required");
    res.json(await practice.say(req.user, parseId(req.params.id), req.body.text));
  } catch (err) {
    handle(err, res, next);
  }
});

router.post("/:id/finish", async (req, res, next) => {
  try {
    res.json(await practice.finish(req.user, parseId(req.params.id)));
  } catch (err) {
    handle(err, res, next);
  }
});

module.exports = router;
