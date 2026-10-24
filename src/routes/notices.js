const express = require("express");
const { requireAuth } = require("../middleware/auth");
const notify = require("../services/notify");

// The bell on the home page: everything Ledger told me (services/notify.js).
//   GET  /api/notices?before=<id>  -> { items, more, unread }
//   GET  /api/notices/unread       -> { unread }
//   POST /api/notices/seen  { upTo } or { ids }
const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const before = req.query.before === undefined ? undefined : Number(req.query.before);
    res.json(await notify.bell(req.user.id, { before, limit: req.query.limit }));
  } catch (err) {
    next(err);
  }
});

router.get("/unread", async (req, res, next) => {
  try {
    res.json({ unread: await notify.bellUnread(req.user.id) });
  } catch (err) {
    next(err);
  }
});

router.post("/seen", async (req, res, next) => {
  try {
    const { ids, upTo } = req.body || {};
    res.json({ seen: await notify.markSeen(req.user.id, { ids, upTo: upTo === undefined ? undefined : Number(upTo) }) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
