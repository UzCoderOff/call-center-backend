const express = require("express");
const { collectsCalls } = require("../lib/calling");
const prisma = require("../lib/prisma");
const env = require("../config/env");
const { startSession, endSession, publicMe } = require("../lib/session");
const { checkCredentials } = require("./auth");
const { generateDeviceToken, hashDeviceToken, requireDevice } = require("../middleware/deviceAuth");
const pbxProvision = require("../services/pbx/provision");
const pbxState = require("../services/pbx/state");
const { pbxSettings } = require("../services/pbx/settings");

// Endpoints for the Android app. The app signs in once with the person's
// normal portal username/password and gets a device token back; after that
// it never asks for the password again:
//
//   POST /api/device/login    username+password -> device token (+ portal session cookie)
//   POST /api/device/session  device token -> fresh portal session cookie (the in-app portal
//                             view uses it, so a 12h cookie expiry never logs anyone out)
//   GET  /api/device/config   device token -> "collect calls?", calling, update info
//   POST /api/device/logout   device token -> token revoked
//   POST /api/device/push     { token } this phone's Google push address (app 3.0+)
//   POST /api/device/sip      this phone's sign-in to Ledger's phone line, shown once
//
// Call syncing itself (POST /api/calls/sync) accepts the same device token.
const router = express.Router();

// Calling through Ledger's phone line, for the app (null: not for them):
// their phone ID, where to connect, whether calls can go outside yet, and
// whether this phone holds the current sign-in (if not, it asks /sip).
async function callingFor(device, employee) {
  if (!pbxState.enabled || !employee?.active || !employee.pbxCalling) return null;
  const [line, settings] = await Promise.all([prisma.pbxExtension.findUnique({ where: { employeeId: employee.id } }), pbxSettings()]);
  return {
    ext: line?.ext ?? null,
    host: env.pbx.sipHost,
    port: env.pbx.sipPort,
    transport: "tls",
    realm: env.pbx.realm,
    canCallOut: line?.canCallOut ?? true,
    // The outside line is connected: calls to clients can go out.
    outboundReady: Boolean(settings.trunkEnabled),
    signedIn: Boolean(line?.ha1Enc && line.secretDeviceId === device.id),
  };
}

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
      // Only the jobs whose calls matter (src/lib/calling.js).
      collectCalls: Boolean(employee?.active && collectsCalls(employee)),
      syncIntervalMinutes: SYNC_INTERVAL_MINUTES,
      calling: await callingFor(req.device, employee),
      latestApp: env.appLatest.versionCode ? env.appLatest : null,
    });
  } catch (err) {
    next(err);
  }
});

// This phone's Google push address (Firebase gives the app one and changes
// it now and then). With it, a call can wake the phone (services/pbx/wake.js).
router.post("/push", requireDevice, async (req, res, next) => {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!token || token.length > 4096) return res.status(400).json({ error: "invalid token" });
    if (token !== req.device.fcmToken) {
      // An address belongs to one phone: a reinstalled app gets a new one,
      // and the old device row (signed out) shouldn't keep it.
      await prisma.device.updateMany({ where: { fcmToken: token, NOT: { id: req.device.id } }, data: { fcmToken: null } });
      await prisma.device.update({ where: { id: req.device.id }, data: { fcmToken: token, fcmTokenAt: new Date() } });
      pbxProvision.scheduleApply(); // whether their phone can be woken changed
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// One of this person's notifications, for the app to show (Google push
// carried only its id — services/notify.js).
router.get("/notices/:id", requireDevice, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const notice = Number.isInteger(id) ? await prisma.notice.findUnique({ where: { id } }) : null;
    if (!notice || notice.userId !== req.user.id) return res.status(404).json({ error: "not_found" });
    res.json(require("../services/notify").publicNotice(notice));
  } catch (err) {
    next(err);
  }
});

// Who's on the other end of a call, for the call screen: ?number=
// (services/pbx/callerCard.js — as much as this person may see).
router.get("/caller", requireDevice, async (req, res, next) => {
  try {
    res.json(await require("../services/pbx/callerCard").callerCard(req.user, String(req.query.number || "").slice(0, 40)));
  } catch (err) {
    next(err);
  }
});

// "Remind me" on a call coming in: { phone, name?, minutes } — a reminder to
// call this number back (services/reminders.js).
router.post("/reminders", requireDevice, async (req, res, next) => {
  try {
    const b = req.body || {};
    const phone = typeof b.phone === "string" ? b.phone.trim() : "";
    const minutes = Number(b.minutes);
    if (!/^[+\d][\d\s()-]{2,30}$/.test(phone)) return res.status(400).json({ error: "invalid phone" });
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 7 * 24 * 60) return res.status(400).json({ error: "invalid minutes" });
    const { callBackReminder, publicReminder, planOne } = require("../services/reminders");
    const row = await callBackReminder(req.user, { phone, name: b.name, minutes });
    planOne(row);
    res.status(201).json(publicReminder(row));
  } catch (err) {
    next(err);
  }
});

// This phone's sign-in to the phone line: a new secret for their phone ID,
// given to this phone only (the previous phone or test softphone signs out
// of the line). Shown once; the app keeps it in the Android Keystore.
router.post("/sip", requireDevice, async (req, res, next) => {
  try {
    const employee = req.user.employee;
    if (!pbxState.enabled) return res.status(409).json({ error: "pbx_off" });
    if (!employee?.active || !employee.pbxCalling) return res.status(403).json({ error: "calling_off" });
    const { ext, secret } = await pbxProvision.issueSecret(employee.id, req.device.id);
    res.json({ ext, secret, ...(await callingFor(req.device, employee)), signedIn: true });
  } catch (err) {
    next(err);
  }
});

router.post("/logout", requireDevice, async (req, res, next) => {
  try {
    await prisma.device.update({ where: { id: req.device.id }, data: { revokedAt: new Date() } });
    await pbxProvision.revokeDevice(req.device.id);
    endSession(res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
