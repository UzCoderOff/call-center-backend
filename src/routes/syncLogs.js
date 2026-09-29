const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, requireRole, MANAGER_ROLES } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole(...MANAGER_ROLES));

// Recent sync attempts across all devices, newest first — success and
// failure both, optionally filtered to one employeeId. This is what makes
// a "stuck on Syncing" report diagnosable from the portal instead of only
// from an on-device log an employee has to manually export and send over:
// every attempt lands here the moment the device tries, including ones
// that failed before we even knew which employee it was (bad JSON, a
// multer/multipart error).
router.get("/", async (req, res, next) => {
  try {
    const { employeeId, limit } = req.query;
    const take = Math.min(Number(limit) || 100, 500);
    const logs = await prisma.syncLog.findMany({
      where: employeeId ? { employeeId: String(employeeId) } : undefined,
      orderBy: { createdAt: "desc" },
      take,
    });
    // SyncLog.employeeId holds the phone's legacy sync token, which lets
    // anyone who has it send calls as that person — only the DEVELOPER sees
    // it; everyone else gets the person's name.
    if (req.user.role === "DEVELOPER") return res.json(logs);
    const tokens = [...new Set(logs.map((l) => l.employeeId).filter(Boolean))];
    const people = new Map(
      (await prisma.employee.findMany({ where: { employeeId: { in: tokens } }, select: { id: true, name: true, employeeId: true } })).map((e) => [e.employeeId, e])
    );
    res.json(logs.map(({ employeeId: token, ...l }) => ({ ...l, employee: people.has(token) ? { id: people.get(token).id, name: people.get(token).name } : null })));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
