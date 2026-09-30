const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const prisma = require("../lib/prisma");
const env = require("../config/env");
const { firmDate } = require("../lib/firmTime");

// Backups.
//
// Local: a dated copy of the database, storage/backups/ledger-YYYY-MM-DD.db,
// the last KEEP kept. Safe while the server runs — SQLite's VACUUM INTO
// writes a consistent snapshot, checked before it replaces the day's copy.
//
// Off the server: the same copy, encrypted, to Google Drive with rclone
// (scripts/offsite-backup.js, set up once with scripts/offsite-setup.js).
// rclone's "crypt" encrypts file contents and names before they leave the
// server; Google only ever holds scrambled files. Kept there: every day for
// DAILY_DAYS, and the last copy of each month for MONTHLY_DAYS. Recordings
// and materials go too (only new files each night; never deleted there).

const KEEP = 14;
const DAILY_DAYS = 31;
const MONTHLY_DAYS = 400;
// rclone's config for Ledger's own remotes, apart from anything else on the
// machine: "gdrive" (the Google account) and "ledger-backup" (encrypted,
// inside gdrive:ledger-backups).
const REMOTE = "ledger-backup";
const backupsDir = () => path.join(path.dirname(env.storageRoot), "backups");
const offsiteDir = () => path.join(path.dirname(env.storageRoot), "offsite");
const rcloneConfig = () => process.env.RCLONE_CONFIG_FILE || path.join(offsiteDir(), "rclone.conf");

// SQLite's own check of the copy, opened read-only on its own.
async function checkCopy(file) {
  const { PrismaClient } = require("@prisma/client");
  const copy = new PrismaClient({ datasources: { db: { url: `file:${file}?mode=ro` } } });
  try {
    const rows = await copy.$queryRawUnsafe("PRAGMA quick_check");
    return rows.map((r) => Object.values(r)[0]);
  } finally {
    await copy.$disconnect();
  }
}

async function makeLocalBackup() {
  const dir = backupsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ledger-${firmDate()}.db`);
  // Written under a temporary name first: if it fails (a full disk), the
  // copy already made today is still there. VACUUM INTO won't overwrite.
  const temp = `${file}.part`;
  fs.rmSync(temp, { force: true });
  await prisma.$executeRawUnsafe(`VACUUM INTO '${temp.replace(/'/g, "''")}'`);
  // A copy that doesn't check out is not kept.
  const [check] = await checkCopy(temp);
  if (check !== "ok") {
    fs.rmSync(temp, { force: true });
    throw new Error(`the copy failed its integrity check (${check})`);
  }
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
  const size = fs.statSync(file).size;

  const old = fs
    .readdirSync(dir)
    .filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .reverse()
    .slice(KEEP);
  for (const f of old) fs.rmSync(path.join(dir, f));
  return { file, size, removed: old.length };
}

// ------------------------------------------------------------------ rclone
// RCLONE_BIN: another rclone (tests use a stand-in script).
function rcloneCommand() {
  const bin = process.env.RCLONE_BIN || "rclone";
  return bin.endsWith(".js") ? [process.execPath, [bin]] : [bin, []];
}

function rclone(args, { timeoutMs = 60 * 60 * 1000, withConfig = true } = {}) {
  const [bin, pre] = rcloneCommand();
  const all = [...pre, ...(withConfig ? ["--config", rcloneConfig()] : []), ...args];
  return new Promise((resolve, reject) => {
    execFile(bin, all, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`rclone ${args[0]} failed: ${(stderr || err.message).trim().split("\n").slice(-3).join(" ")}`);
        e.code = err.code;
        return reject(e);
      }
      resolve(stdout);
    });
  });
}

const offsiteConfigured = () => fs.existsSync(rcloneConfig());

// Tonight's copy to Drive: the day's file, this month's file (the latest of
// the month stays), old dailies pruned; then new recordings and materials.
// Returns what happened, step by step, for the log and the Telegram note.
async function sendOffsite(local, { files = true } = {}) {
  const name = path.basename(local.file); // ledger-YYYY-MM-DD.db
  const month = name.slice(7, 14);
  const steps = [];
  const step = async (label, fn) => {
    try {
      await fn();
      steps.push({ label, ok: true });
    } catch (err) {
      steps.push({ label, ok: false, error: err.message });
    }
  };
  await step("database", () => rclone(["copyto", local.file, `${REMOTE}:daily/${name}`]));
  await step("month", () => rclone(["copyto", local.file, `${REMOTE}:monthly/ledger-${month}.db`]));
  await step("prune", async () => {
    await rclone(["delete", `${REMOTE}:daily`, "--min-age", `${DAILY_DAYS}d`]);
    await rclone(["delete", `${REMOTE}:monthly`, "--min-age", `${MONTHLY_DAYS}d`]);
  });
  if (files) {
    if (fs.existsSync(env.storageRoot)) await step("recordings", () => rclone(["copy", env.storageRoot, `${REMOTE}:recordings`]));
    if (fs.existsSync(env.materialsDir)) await step("materials", () => rclone(["copy", env.materialsDir, `${REMOTE}:materials`]));
  }
  return steps;
}

module.exports = { makeLocalBackup, sendOffsite, rclone, rcloneConfig, offsiteDir, offsiteConfigured, backupsDir, REMOTE, KEEP, DAILY_DAYS, MONTHLY_DAYS };
