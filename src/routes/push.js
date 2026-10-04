const express = require("express");
const prisma = require("../lib/prisma");
const env = require("../config/env");
const { requireAuth } = require("../middleware/auth");
const web = require("../services/push/web");

// Notifications in this browser (the portal, services/push/web.js):
//
//   GET    /api/push/web             { publicKey } — null when browsers get none
//   POST   /api/push/web             { endpoint, keys: { p256dh, auth } } — this browser, for me
//   DELETE /api/push/web             { endpoint } — this browser no more (signing out)
const router = express.Router();
router.use(requireAuth);

const isText = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;

router.get("/web", (req, res) => {
  res.json({ publicKey: web.configured() ? env.webPush.publicKey : null });
});

router.post("/web", async (req, res, next) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!isText(endpoint, 2000) || !/^https:\/\//.test(endpoint) || !isText(keys?.p256dh, 200) || !isText(keys?.auth, 100)) {
      return res.status(400).json({ error: "invalid subscription" });
    }
    const data = { userId: req.user.id, p256dh: keys.p256dh, auth: keys.auth, userAgent: String(req.get("user-agent") || "").slice(0, 300) };
    // A browser belongs to whoever signed in on it last.
    await prisma.webPushSubscription.upsert({ where: { endpoint }, update: data, create: { endpoint, ...data } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/web", async (req, res, next) => {
  try {
    const endpoint = req.body?.endpoint;
    if (isText(endpoint, 2000)) await prisma.webPushSubscription.deleteMany({ where: { endpoint, userId: req.user.id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
