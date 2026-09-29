const express = require("express");
const prisma = require("../lib/prisma");
const env = require("../config/env");
const { startSession, endSession, publicMe } = require("../lib/session");
const { checkCredentials } = require("./auth");
const { generateDeviceToken, hashDeviceToken, requireDevice } = require("../middleware/deviceAuth");

// Endpoints for the Android app. The app signs in once with the person's
// normal portal username/password and gets a device token back; after that
// it never asks for the password again:
//
//   POST /api/device/login    username+password -> device token (+ portal session cookie)
//   POST /api/device/session  device token -> fresh portal session cookie (the in-app portal
//                             view uses it, so a 12h cookie expiry never logs anyone out)
//   GET  /api/device/config   device token -> "collect calls?" + update info
//   POST /api/device/logout   device token -> token revoked
//
// Call syncing itself (POST /api/calls/sync) accepts the same device token.
const router = express.Router();

const SYNC_INTERVAL_MINUTES = 60;

function clip(value, max) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

router.post("/login", async (req, res, next) => {
  try {
    const { username, password, label, appVersion } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }

    const result = await checkCredentials(req, res, String(username), String(password));
    if (result.error) return res.status(result.status).json({ error: result.error });

    const token = generateDeviceToken();
    await prisma.device.create({
      data: {
        userId: result.user.id,
        tokenHash: hashDeviceToken(token),
        label: clip(label, 80),
        appVersion: clip(appVersion, 40),
      },
    });

    startSession(res, result.user);
    // The token is only ever returned here; only its hash is stored.
    res.status(201).json({ token, user: publicMe(result.user) });
  } catch (err) {
    next(err);
  }
});

router.post("/session", requireDevice, (req, res) => {
  startSession(res, req.user);
  res.json({ user: publicMe(req.user) });
});

router.get("/config", requireDevice, async (req, res, next) => {
  try {
    const appVersion = clip(req.get("x-app-version"), 40);
    if (appVersion && appVersion !== req.device.appVersion) {
      await prisma.device.update({ where: { id: req.device.id }, data: { appVersion } });
    }

    const employee = req.user.employee;
    res.json({
      user: publicMe(req.user),
      // The one switch that decides whether this phone asks for call-log /
      // storage permissions and runs background sync at all.
      collectCalls: Boolean(employee?.active && employee.collectCalls),
      syncIntervalMinutes: SYNC_INTERVAL_MINUTES,
      latestApp: env.appLatest.versionCode ? env.appLatest : null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/logout", requireDevice, async (req, res, next) => {
  try {
    await prisma.device.update({ where: { id: req.device.id }, data: { revokedAt: new Date() } });
    endSession(res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
