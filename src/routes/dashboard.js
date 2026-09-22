const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

function dateRangeFilter(req) {
  if (!req.query.from && !req.query.to) return {};
  const range = {};
  if (req.query.from) range.gte = BigInt(req.query.from);
  if (req.query.to) range.lte = BigInt(req.query.to);
  return { callTimestampMs: range };
}

async function statsForEmployeeIds(employeeIds, dateFilter) {
  const where = { employeeId: { in: employeeIds }, ...dateFilter };
  const [total, missed, durationAgg] = await Promise.all([
    prisma.callLog.count({ where }),
    prisma.callLog.count({ where: { ...where, missed: true } }),
    prisma.callLog.aggregate({ where, _sum: { durationSeconds: true } }),
  ]);
  return {
    totalCalls: total,
    missedCalls: missed,
    answeredCalls: total - missed,
    totalTalkTimeSeconds: durationAgg._sum.durationSeconds || 0,
  };
}

router.get("/", async (req, res, next) => {
  try {
    const dateFilter = dateRangeFilter(req);

    if (req.user.role === "EMPLOYEE") {
      if (!req.user.employee) return res.json({ self: null });
      const self = await statsForEmployeeIds([req.user.employee.id], dateFilter);
      return res.json({ self });
    }

    // BOSS / DEVELOPER: company totals plus a per-employee breakdown.
    const employees = await prisma.employee.findMany({
      where: { active: true },
      select: { id: true, name: true },
    });

    const company = await statsForEmployeeIds(employees.map((e) => e.id), dateFilter);
    const perEmployee = await Promise.all(
      employees.map(async (e) => ({
        employeeId: e.id,
        name: e.name,
        ...(await statsForEmployeeIds([e.id], dateFilter)),
      }))
    );

    res.json({ company, employees: perEmployee });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
