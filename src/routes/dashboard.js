const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isManager } = require("../middleware/auth");
const { parseMs, parseId } = require("../utils/params");
const { computeCallStats, computeDailySeries, blankStats } = require("../services/stats");
const { getSyncHealth } = require("../services/syncHealth");
const { diskSpace } = require("../services/diskSpace");
const { JOBS, parseJobs } = require("../lib/jobs");
const { computeFunnel } = require("../services/funnel");
const { strikeCounts } = require("../services/strikes");
const { DEFAULT_FEE } = require("../services/consultationFee");
const { firmDate } = require("../lib/firmTime");
const { FOLLOW_UP_WINDOW_MS, NEEDS_CALLBACK_STATUSES } = require("../services/followUp");

const router = express.Router();
router.use(requireAuth);

// The "call these people back" preview. Not tied to the selected date
// range on purpose: it's a to-do list, and anything still unreached within
// the follow-up window belongs on it.
async function needsCallbackPreview(employeeIds) {
  const where = {
    missed: true,
    followUp: { in: NEEDS_CALLBACK_STATUSES },
    callTimestampMs: { gte: BigInt(Date.now() - FOLLOW_UP_WINDOW_MS) },
    ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
  };
  const [count, items] = await Promise.all([
    prisma.callLog.count({ where }),
    prisma.callLog.findMany({
      where,
      orderBy: { callTimestampMs: "desc" },
      take: 5,
      select: {
        id: true,
        phoneNumber: true,
        callType: true,
        callTimestampMs: true,
        followUp: true,
        employee: { select: { id: true, name: true } },
      },
    }),
  ]);
  return { count, items };
}

// The same numbers for the period before (prevFrom/prevTo: e.g. the same
// days of last month), so the page can say "+12%". Totals only.
async function previousTotals(employeeIds, prevFrom, prevTo) {
  if (prevFrom === undefined || prevTo === undefined || prevTo <= prevFrom) return null;
  return (await computeCallStats({ employeeIds, from: prevFrom, to: prevTo })).totals;
}

// GET /api/dashboard?from=&to=&tzOffset=[&employeeId=][&prevFrom=&prevTo=]
//   EMPLOYEE                    -> scope "self": their own numbers + their phone's sync status
//   BOSS/DEVELOPER              -> scope "company": totals + one row per employee
//   BOSS/DEVELOPER + employeeId -> scope "employee": one employee, same shape as "self"
// tzOffset is the viewer's UTC offset in minutes, for the per-day chart.
router.get("/", async (req, res, next) => {
  try {
    const from = parseMs(req.query.from, "from");
    const to = parseMs(req.query.to, "to");
    const tzOffsetMin = Math.max(-840, Math.min(840, Number(req.query.tzOffset) || 0));
    const prevFrom = parseMs(req.query.prevFrom, "prevFrom");
    const prevTo = parseMs(req.query.prevTo, "prevTo");

    if (isManager(req.user) && req.query.employeeId) {
      const employee = await prisma.employee.findUnique({ where: { id: parseId(req.query.employeeId, "employeeId") } });
      if (!employee) return res.status(404).json({ error: "not_found" });
      const employeeIds = [employee.id];
      const [{ totals }, daily, needsCallback, health, funnel, previous] = await Promise.all([
        computeCallStats({ employeeIds, from, to }),
        computeDailySeries({ employeeIds, from, to, tzOffsetMin }),
        needsCallbackPreview(employeeIds),
        getSyncHealth([employee]),
        computeFunnel({ employeeIds, from, to, fee: DEFAULT_FEE }),
        previousTotals(employeeIds, prevFrom, prevTo),
      ]);
      return res.json({ scope: "employee", totals, previous, daily, needsCallback, funnel, sync: health.get(employee.id) });
    }

    if (!isManager(req.user)) {
      const self = req.user.employee;
      if (!self) {
        return res.json({ scope: "self", totals: blankStats(), daily: [], needsCallback: { count: 0, items: [] }, sync: null });
      }
      const employeeIds = [self.id];
      const [{ totals }, daily, needsCallback, health, funnel, strikes, previous] = await Promise.all([
        computeCallStats({ employeeIds, from, to }),
        computeDailySeries({ employeeIds, from, to, tzOffsetMin }),
        needsCallbackPreview(employeeIds),
        getSyncHealth([self]),
        computeFunnel({ employeeIds, from, to, fee: DEFAULT_FEE }),
        strikeCounts(employeeIds, firmDate().slice(0, 7)),
        previousTotals(employeeIds, prevFrom, prevTo),
      ]);
      // Their strikes this month, and the rule (when it's on). Not the fine:
      // that's between them and the boss (Natijalar).
      const mine = strikes.counts.get(self.id);
      const strike = strikes.rules.enabled && self.job === "call_center" ? { count: mine.count, limit: mine.limit, over: mine.over, minutes: strikes.rules.minutes } : null;
      return res.json({ scope: "self", totals, previous, daily, needsCallback, funnel, strikes: strike, sync: health.get(self.id) });
    }

    const everyone = await prisma.employee.findMany({
      select: { id: true, name: true, active: true, employeeId: true, collectCalls: true, job: true },
      orderBy: { name: "asc" },
    });
    // ?jobs=call_center,… — whose phones these numbers are about (the portal
    // asks for the call center by default). Without it: everyone's.
    const jobs = parseJobs(req.query.jobs);
    const employees = jobs ? everyone.filter((e) => jobs.includes(e.job)) : everyone;
    const employeeIds = jobs ? employees.map((e) => e.id) : null;
    // How many monitored phones each job has, for the portal's switches.
    const phonesByJob = Object.fromEntries(JOBS.map((j) => [j, everyone.filter((e) => e.active && e.collectCalls && e.job === j).length]));
    const collecting = employees.filter((e) => e.collectCalls);
    const [{ totals, byEmployee }, daily, needsCallback, health, funnel, strikes, previous] = await Promise.all([
      computeCallStats({ employeeIds, from, to }),
      computeDailySeries({ employeeIds, from, to, tzOffsetMin }),
      needsCallbackPreview(employeeIds),
      getSyncHealth(collecting),
      computeFunnel({ employeeIds, from, to, fee: DEFAULT_FEE }),
      strikeCounts(employees.map((e) => e.id), firmDate().slice(0, 7)),
      previousTotals(employeeIds, prevFrom, prevTo),
    ]);

    // One row per active call-collecting employee. Anyone else with calls in
    // the range (deactivated, collection since switched off) still shows,
    // so the rows always add up to the company totals.
    const rows = employees
      .filter((e) => (e.active && e.collectCalls) || byEmployee.has(e.id))
      .map((e) => ({
        id: e.id,
        name: e.name,
        active: e.active,
        collectCalls: e.collectCalls,
        ...(byEmployee.get(e.id) || blankStats()),
        sync: health.get(e.id) ?? null,
        job: e.job,
        // This month's late call-back strikes (when the rule is on).
        strikes: strikes.rules.enabled && e.job === "call_center" ? strikes.counts.get(e.id) : null,
      }));

    // The developer also sees when the server's disk is getting full.
    const disk = req.user.role === "DEVELOPER" ? await diskSpace() : null;
    res.json({
      scope: "company",
      totals,
      previous,
      daily,
      needsCallback,
      funnel,
      employees: rows,
      jobs: jobs || JOBS,
      phonesByJob,
      strikeRules: strikes.rules.enabled ? { minutes: strikes.rules.minutes, limit: strikes.rules.limit, fine: strikes.rules.fine } : null,
      ...(disk ? { disk } : {}),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
