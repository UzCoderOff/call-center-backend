const express = require("express");
const { requireAuth } = require("../middleware/auth");
const live = require("../services/live");

// GET /api/live?v=<last version>  -> { v } once something of mine changed
// (or after ~20 s with the same v). See services/live.js.
const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const since = req.query.v === undefined ? NaN : Number(req.query.v);
    const aborted = new AbortController();
    // The answer is no longer wanted (the tab closed, the phone went offline).
    res.on("close", () => aborted.abort());
    const v = await live.waitFor(req.user.id, since, { signal: aborted.signal });
    if (!res.writableEnded && !aborted.signal.aborted) res.set("Cache-Control", "no-store").json({ v });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
