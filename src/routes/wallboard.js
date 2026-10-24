const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const wallboard = require("../services/wallboard");

// The office TV (services/wallboard.js).
//   GET    /api/wallboard/link        managers: the TV link's secret, or null
//   POST   /api/wallboard/link        managers: a new one (the old stops working)
//   DELETE /api/wallboard/link        managers: switch it off
//   GET    /api/wallboard/tv/:token   the TV itself, no login: today's numbers
const router = express.Router();

router.get("/tv/:token", async (req, res, next) => {
  try {
    if (!(await wallboard.validToken(String(req.params.token || "")))) return res.status(404).json({ error: "not_found" });
    res.set("Cache-Control", "no-store").json(await wallboard.data());
  } catch (err) {
    next(err);
  }
});

const managers = [requireAuth, requireRole("BOSS", "DEVELOPER")];

router.get("/link", ...managers, async (req, res, next) => {
  try {
    res.json({ link: await wallboard.link() });
  } catch (err) {
    next(err);
  }
});

router.post("/link", ...managers, async (req, res, next) => {
  try {
    res.json({ link: await wallboard.renew(req.user) });
  } catch (err) {
    next(err);
  }
});

router.delete("/link", ...managers, async (req, res, next) => {
  try {
    await wallboard.revoke(req.user);
    res.json({ link: null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
