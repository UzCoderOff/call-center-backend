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
    res.json(logs);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
