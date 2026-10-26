const express = require("express");
const prisma = require("../lib/prisma");
const env = require("../config/env");
const { requireAuth, requireRole, MANAGER_ROLES } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { hasJob } = require("../lib/jobs");
const pbx = require("../services/pbx");
const state = require("../services/pbx/state");
const provision = require("../services/pbx/provision");
const secrets = require("../services/pbx/secrets");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { pbxSettings, savePbxSettings, HHMM } = require("../services/pbx/settings");
const sounds = require("../services/pbx/sounds");
const { normalizeUz } = require("../services/pbx/numbers");

// Ledger's phone line in the portal (Settings → Phone line):
//   GET  /api/pbx/status                       managers: is it running, who's on it
//   PUT  /api/pbx/settings                     developer: company number, outside line,
//                                              night hours { on, from, to }, test
//                                              numbers (up to 5 Uzbek phones)
//   PUT  /api/pbx/sounds/:key                  developer: a voice message (the
//                                              recording's bytes; sounds.js KEYS)
//   GET  /api/pbx/sounds/:key                  managers: listen to it (MP3)
//   DELETE /api/pbx/sounds/:key                developer: remove it
//   GET  /api/pbx/live                         the developer and accounts with
//                                              "listens to calls": client calls
//                                              going on right now
//   POST /api/pbx/live/:id/listen              -> { url } to listen to one live
//                                              (live.js; the address is
//                                              /api/pbx-listen/<token>)
//   POST /api/pbx/extensions/:employeeId/softphone
//        developer: a sign-in for a test softphone (MicroSIP, Zoiper) on that
//        person's phone ID — shown once; their Ledger app is signed out of
//        the line until it signs in again
const router = express.Router();
router.use(requireAuth);

const live = require("../services/pbx/live");

function requireHears(req, res, next) {
  if (!live.canHearCalls(req.user)) return res.status(403).json({ error: "forbidden" });
  next();
}

router.get("/live", requireHears, async (req, res, next) => {
  try {
    res.json({ calls: await live.snapshot(req.user) });
  } catch (err) {
    next(err);
  }
});

router.post("/live/:id/listen", requireHears, async (req, res, next) => {
  try {
    const token = await live.listenToken(req.user, String(req.params.id).slice(0, 64));
    if (!token) return res.status(409).json({ error: "not_listenable" });
    // The portal is on another address in production: the sound comes
    // straight from this server (env PUBLIC_API_URL), not through the
    // portal's proxy.
    res.json({ url: `${env.publicApiUrl || ""}/api/pbx-listen/${token}` });
  } catch (err) {
    next(err);
  }
});

// Which phone IDs have a phone connected right now (Asterisk's view).
async function onlineExts() {
  if (!state.ami?.ready) return null;
  try {
    const contacts = await state.ami.actionList({ Action: "PJSIPShowContacts" });
    return new Set(contacts.filter((c) => c.Event === "ContactList" && /^(Reachable|NonQualified|Unknown)$/i.test(c.Status || "")).map((c) => c.Aor));
  } catch {
    return null;
  }
}

router.get("/status", requireRole(...MANAGER_ROLES), async (req, res, next) => {
  try {
    const [rows, settings, online] = await Promise.all([
      prisma.pbxExtension.findMany({ include: { employee: { select: { id: true, name: true, active: true, pbxCalling: true, job: true, extraJobs: true } } }, orderBy: { ext: "asc" } }),
      pbxSettings(),
      onlineExts(),
    ]);
    const now = new Date();
    res.json({
      ...pbx.status(),
      canIssue: secrets.hasKey(),
      sip: { host: env.pbx.sipHost, port: env.pbx.sipPort, transport: "TLS" },
      settings: { companyNumber: settings.companyNumber, trunkEnabled: settings.trunkEnabled, night: settings.night, testNumbers: settings.testNumbers },
      sounds: sounds.present(),
      firmTimezone: env.firmTimezone,
      people: rows
        .filter((r) => r.employee.active && r.employee.pbxCalling)
        .map((r) => ({
          employeeId: r.employee.id,
          name: r.employee.name,
          ext: r.ext,
          callCenter: hasJob(r.employee, "call_center"),
          signedIn: Boolean(r.ha1Enc),
          viaApp: r.secretDeviceId != null,
          online: online ? online.has(r.ext) : null,
          canCallOut: r.canCallOut,
          restingUntil: r.restingUntil && r.restingUntil > now ? r.restingUntil : null,
        })),
    });
  } catch (err) {
    next(err);
  }
});

router.put("/settings", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const patch = {};
    if (req.body?.companyNumber !== undefined) {
      const number = String(req.body.companyNumber || "").replace(/[^\d+]/g, "");
      if (number && !/^\+?\d{9,15}$/.test(number)) throw badRequest("invalid companyNumber");
      patch.companyNumber = number;
    }
    if (req.body?.trunkEnabled !== undefined) {
      if (typeof req.body.trunkEnabled !== "boolean") throw badRequest("trunkEnabled must be true or false");
      patch.trunkEnabled = req.body.trunkEnabled;
    }
    if (req.body?.night !== undefined) {
      const { on, from, to } = req.body.night || {};
      if (typeof on !== "boolean") throw badRequest("night.on must be true or false");
      if (!HHMM.test(String(from)) || !HHMM.test(String(to)) || from === to) throw badRequest("night needs two different times, HH:MM");
      patch.night = { on, from, to };
    }
    if (req.body?.testNumbers !== undefined) {
      const list = Array.isArray(req.body.testNumbers) ? req.body.testNumbers : String(req.body.testNumbers || "").split(/[,;]+/);
      const numbers = [];
      for (const raw of list.map((n) => String(n).trim()).filter(Boolean)) {
        const uz = normalizeUz(raw);
        if (!uz.e164) throw badRequest("invalid testNumbers");
        if (!numbers.includes(uz.e164)) numbers.push(uz.e164);
      }
      if (numbers.length > 5) throw badRequest("at most 5 testNumbers");
      patch.testNumbers = numbers;
    }
    await savePbxSettings(patch, req.user.id);
    if (patch.night) await prisma.auditLog.create({ data: { userId: req.user.id, action: "pbx.night", entity: "setting", entityId: null, detail: patch.night } });
    provision.scheduleApply();
    const settings = await pbxSettings();
    res.json({ companyNumber: settings.companyNumber, trunkEnabled: settings.trunkEnabled, night: settings.night, testNumbers: settings.testNumbers });
  } catch (err) {
    next(err);
  }
});

// The firm's voice messages on the line (sounds.js). The portal sends a
// short recording as one piece (it makes it a 16 kHz WAV first, well under
// the limit); ffmpeg makes the phone's copies. Asterisk is told at once.
function soundKey(req) {
  const key = String(req.params.key);
  if (!sounds.isKey(key)) throw Object.assign(new Error("not_found"), { status: 404 });
  return key;
}

router.put("/sounds/:key", requireRole("DEVELOPER"), express.raw({ type: () => true, limit: "1mb" }), async (req, res, next) => {
  const tmp = path.join(os.tmpdir(), `ledger-sound-${crypto.randomBytes(6).toString("hex")}`);
  try {
    const key = soundKey(req);
    if (!Buffer.isBuffer(req.body) || req.body.length < 1000) throw badRequest("empty recording");
    fs.writeFileSync(tmp, req.body);
    let saved;
    try {
      saved = await sounds.save(key, tmp);
    } catch (err) {
      if (err.message !== "not_audio") throw err;
      console.warn(`[pbx] voice message ${key} not taken: ${err.detail}`);
      return res.status(400).json({ error: "not_audio" });
    }
    await prisma.auditLog.create({ data: { userId: req.user.id, action: "pbx.sound", entity: "setting", entityId: null, detail: { key, seconds: saved?.seconds ?? null } } });
    await provision.applyNow();
    res.json({ key, ...saved });
  } catch (err) {
    next(err);
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
});

router.get("/sounds/:key", requireRole(...MANAGER_ROLES), (req, res, next) => {
  try {
    const file = sounds.listenFile(soundKey(req));
    if (!file) return res.status(404).json({ error: "not_found" });
    res.set("Cache-Control", "no-store");
    res.type("audio/mpeg").sendFile(file);
  } catch (err) {
    next(err);
  }
});

router.delete("/sounds/:key", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const key = soundKey(req);
    sounds.remove(key);
    await prisma.auditLog.create({ data: { userId: req.user.id, action: "pbx.sound.remove", entity: "setting", entityId: null, detail: { key } } });
    await provision.applyNow();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/extensions/:employeeId/softphone", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    if (!secrets.hasKey()) return res.status(409).json({ error: "pbx_not_configured" });
    const employee = await prisma.employee.findUnique({ where: { id: parseId(req.params.employeeId, "employeeId") } });
    if (!employee || !employee.active) return res.status(404).json({ error: "not_found" });
    if (!employee.pbxCalling) return res.status(409).json({ error: "calling_off" });
    const { ext, secret } = await provision.issueSecret(employee.id, null);
    await prisma.auditLog.create({ data: { userId: req.user.id, action: "pbx.softphone", entity: "employee", entityId: employee.id, detail: { ext } } });
    res.json({ ext, password: secret, domain: env.pbx.sipHost, port: env.pbx.sipPort, transport: "TLS", realm: env.pbx.realm });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
