const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isManager } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { isCallCenter } = require("../lib/jobs");
const co = require("../services/callOutcomes");

// New callers who didn't book — and why (services/callOutcomes.js).
//
//   GET /api/call-outcomes[?employeeId=]   the numbers still to answer for:
//         the call center's own; managers: everyone's, or one person's
//   PUT /api/call-outcomes/:phoneKey        { outcome, note? } — outcome null
//         takes it back. "other" needs a word. A number on their own list, or
//         the answer they gave themselves (to change or take back); managers
//         any. It stays credited to the operator who talked to the caller.
const router = express.Router();
router.use(requireAuth);

const MAX_ITEMS = 100;

router.get("/", async (req, res, next) => {
  try {
    let employeeIds;
    if (isManager(req.user)) {
      employeeIds = req.query.employeeId ? [parseId(req.query.employeeId, "employeeId")] : await co.callCenterIds();
    } else {
      const self = req.user.employee;
      employeeIds = self && isCallCenter(self) ? [self.id] : [];
    }
    const items = await co.pending({ employeeIds });
    const names = new Map((await prisma.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
    res.json({
      outcomes: co.OUTCOMES,
      asked: employeeIds.length > 0,
      count: items.length,
      items: items.slice(0, MAX_ITEMS).map((r) => ({ ...r, employee: r.employeeId ? { id: r.employeeId, name: names.get(r.employeeId) || null } : null })),
    });
  } catch (err) {
    next(err);
  }
});

router.put("/:phoneKey", async (req, res, next) => {
  try {
    const phoneKey = String(req.params.phoneKey || "");
    if (!/^\d{5,15}$/.test(phoneKey)) throw badRequest("invalid phoneKey");
    const b = req.body || {};
    const outcome = b.outcome === null ? null : String(b.outcome || "");
    if (outcome !== null && !co.OUTCOMES.includes(outcome)) throw badRequest("invalid outcome");
    const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 300) : null;
    if (outcome === "other" && !note) throw badRequest("note_required");
    const existing = await prisma.callOutcome.findUnique({ where: { phoneKey } });
    const manager = isManager(req.user);
    // Whose caller: the operator on whose list it is (or was, when answered).
    const listed = (await co.pending({ employeeIds: manager ? await co.callCenterIds() : req.user.employee ? [req.user.employee.id] : [] })).find((r) => r.phoneKey === phoneKey);
    if (!manager && !listed && existing?.createdById !== req.user.id) return res.status(404).json({ error: "not_found" });
    const employeeId = listed?.employeeId ?? existing?.employeeId ?? req.user.employee?.id ?? null;
    const row = await co.record({ user: req.user, phoneKey, outcome, note, employeeId });
    res.json({ phoneKey, outcome: row?.outcome ?? null, note: row?.note ?? null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
