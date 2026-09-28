const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isManager } = require("../middleware/auth");
const { parseMs, parseId } = require("../utils/params");
const { computeCallStats, computeDailySeries, blankStats } = require("../services/stats");
const { getSyncHealth } = require("../services/syncHealth");
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

// GET /api/dashboard?from=&to=&tzOffset=[&employeeId=]
//   EMPLOYEE                    -> scope "self": their own numbers + their phone's sync status
//   BOSS/DEVELOPER              -> scope "company": totals + one row per employee
//   BOSS/DEVELOPER + employeeId -> scope "employee": one employee, same shape as "self"
// tzOffset is the viewer's UTC offset in minutes, for the per-day chart.
router.get("/", async (req, res, next) => {
  try {
    const from = parseMs(req.query.from, "from");
    const to = parseMs(req.query.to, "to");
    const tzOffsetMin = Math.max(-840, Math.min(840, Number(req.query.tzOffset) || 0));

    if (isManager(req.user) && req.query.employeeId) {
      const employee = await prisma.employee.findUnique({ where: { id: parseId(req.query.employeeId, "employeeId") } });
      if (!employee) return res.status(404).json({ error: "not_found" });
      const employeeIds = [employee.id];
      const [{ totals }, daily, needsCallback, health] = await Promise.all([
        computeCallStats({ employeeIds, from, to }),
        computeDailySeries({ employeeIds, from, to, tzOffsetMin }),
        needsCallbackPreview(employeeIds),
        getSyncHealth([employee]),
      ]);
      return res.json({ scope: "employee", totals, daily, needsCallback, sync: health.get(employee.id) });
    }

    if (!isManager(req.user)) {
      const self = req.user.employee;
      if (!self) {
        return res.json({ scope: "self", totals: blankStats(), daily: [], needsCallback: { count: 0, items: [] }, sync: null });
      }
      const employeeIds = [self.id];
      const [{ totals }, daily, needsCallback, health] = await Promise.all([
        computeCallStats({ employeeIds, from, to }),
        computeDailySeries({ employeeIds, from, to, tzOffsetMin }),
        needsCallbackPreview(employeeIds),
        getSyncHealth([self]),
      ]);
      return res.json({ scope: "self", totals, daily, needsCallback, sync: health.get(self.id) });
    }

    const employees = await prisma.employee.findMany({
      select: { id: true, name: true, active: true, employeeId: true, collectCalls: true },
      orderBy: { name: "asc" },
    });
    const collecting = employees.filter((e) => e.collectCalls);
    const [{ totals, byEmployee }, daily, needsCallback, health] = await Promise.all([
      computeCallStats({ from, to }),
      computeDailySeries({ from, to, tzOffsetMin }),
      needsCallbackPreview(null),
      getSyncHealth(collecting),
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
      }));

    res.json({ scope: "company", totals, daily, needsCallback, employees: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
