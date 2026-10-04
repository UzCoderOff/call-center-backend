const fs = require("fs");
const path = require("path");
const prisma = require("../../lib/prisma");
const env = require("../../config/env");
const state = require("./state");
const secrets = require("./secrets");
const { renderStaff, renderHints, renderGlobals } = require("./config");
const { pbxSettings } = require("./settings");

// Ledger tells Asterisk who is on the phone line: everyone active with
// "Ledger calls" on gets a phone ID (from 201 up, never reused), and the
// phones that have signed in get a sign-in entry. The files are rewritten
// only when they change, then Asterisk reloads them.

const FIRST_EXT = 201;
const LAST_EXT = 899;

// Numbers the line itself uses (extensions.conf): the company line to try
// it out, and the phone tests.
const RESERVED = new Set(["500", "600", "601", "602"]);

function nextExt(used) {
  for (let n = FIRST_EXT; n <= LAST_EXT; n++) if (!used.has(String(n)) && !RESERVED.has(String(n))) return String(n);
  throw new Error("no free phone IDs left");
}

// Their phone ID — given the first time it's needed, kept for good.
async function ensureExtension(employeeId, db = prisma) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await db.pbxExtension.findUnique({ where: { employeeId } });
    if (existing) return existing;
    const used = new Set((await db.pbxExtension.findMany({ select: { ext: true } })).map((r) => r.ext));
    try {
      return await db.pbxExtension.create({ data: { employeeId, ext: nextExt(used) } });
    } catch (err) {
      if (err.code !== "P2002") throw err; // someone took the same number at once: try again
    }
  }
  throw new Error("could not give a phone ID");
}

// A new sign-in secret for their phone ID; the previous one stops working.
// deviceId: the Ledger app phone it's for; null: a test softphone (developer).
// The secret is returned once and never stored.
async function issueSecret(employeeId, deviceId = null) {
  const row = await ensureExtension(employeeId);
  const secret = secrets.newSecret();
  const ha1Enc = secrets.seal(secrets.ha1(row.ext, env.pbx.realm, secret));
  await prisma.pbxExtension.update({
    where: { id: row.id },
    data: { ha1Enc, secretDeviceId: deviceId, secretIssuedAt: new Date(), wakeFailStreak: 0, restingUntil: null },
  });
  // The phone signs in the moment it has the secret: Asterisk must know it
  // first (a failed sign-in would also count toward fail2ban).
  await Promise.race([applyNow(), new Promise((resolve) => setTimeout(resolve, 5000))]);
  return { ext: row.ext, secret };
}

// A phone signed out of Ledger can't sign in to the line any more.
async function revokeDevice(deviceId) {
  const { count } = await prisma.pbxExtension.updateMany({ where: { secretDeviceId: deviceId }, data: { ha1Enc: null, secretDeviceId: null } });
  if (count) scheduleApply();
}

function openQuietly(sealed) {
  try {
    return secrets.open(sealed);
  } catch {
    return null; // PBX_SECRET_KEY changed: that phone signs in again
  }
}

// Everyone on the line now: [{ ext, employeeId, name, canCallOut, ha1 }].
async function lineMembers(db = prisma) {
  const rows = await db.pbxExtension.findMany({
    where: { employee: { active: true, pbxCalling: true } },
    include: { employee: { select: { name: true } } },
    orderBy: { ext: "asc" },
  });
  return rows.map((r) => ({ ext: r.ext, employeeId: r.employeeId, name: r.employee.name, canCallOut: r.canCallOut, ha1: r.ha1Enc ? openQuietly(r.ha1Enc) : null }));
}

function globalsFor(settings) {
  return {
    LEDGER_HOOK: `http://127.0.0.1:${env.pbx.hookPort}/pbx`,
    LEDGER_HOOK_SECRET: env.pbx.hookSecret || "",
    PBX_MON: env.pbx.monitorDir,
    PBX_SPOOL: env.pbx.spoolDir,
    TRUNK_ENABLED: settings.trunkEnabled ? 1 : 0,
    COMPANY_NUMBER: String(settings.companyNumber || "").replace(/[^\d+]/g, ""),
  };
}

// Writes `text` to `file` only when it differs (atomically); true if it did.
function writeIfChanged(file, text) {
  let old = null;
  try {
    old = fs.readFileSync(file, "utf8");
  } catch {
    // not there yet
  }
  if (old === text) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o640 });
  fs.renameSync(tmp, file);
  return true;
}

let timer = null;
let chain = Promise.resolve();

// Many changes in a row (saving a person, a phone signing in) end in one apply.
function scheduleApply() {
  if (!state.enabled) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    chain = chain.then(apply).catch((err) => console.error("[pbx] updating the phone line failed:", err.message));
  }, 1500);
}

// Right away, and awaited (scheduleApply waits a moment to batch changes).
function applyNow() {
  if (!state.enabled) return Promise.resolve();
  clearTimeout(timer);
  chain = chain.then(apply).catch((err) => console.error("[pbx] updating the phone line failed:", err.message));
  return chain;
}

async function apply() {
  if (!state.enabled) return;
  const [members, settings] = await Promise.all([lineMembers(), pbxSettings()]);
  const dir = env.pbx.confDir;
  const staffChanged = writeIfChanged(path.join(dir, "pjsip_staff.conf"), renderStaff(members.filter((m) => m.ha1), { realm: env.pbx.realm }));
  const hintsChanged = writeIfChanged(path.join(dir, "extensions_ledger.conf"), renderHints(members));
  const globalsChanged = writeIfChanged(path.join(dir, "globals_ledger.conf"), renderGlobals(globalsFor(settings)));
  if (state.ami?.ready) {
    if (staffChanged) await state.ami.action({ Action: "Reload", Module: "res_pjsip.so" });
    if (hintsChanged || globalsChanged) await state.ami.action({ Action: "Reload", Module: "pbx_config.so" });
  }
  await require("./presence").reconcile();
}

module.exports = { FIRST_EXT, RESERVED, nextExt, ensureExtension, issueSecret, revokeDevice, lineMembers, globalsFor, scheduleApply, applyNow, apply };
