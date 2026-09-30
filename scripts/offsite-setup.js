// One-time setup of the Google Drive backup (DEPLOY.md, "Backups").
//
//   npm run backup:offsite-setup
//
// 1. Checks rclone is installed.
// 2. Asks for the Google sign-in token made on your own computer with
//    `rclone authorize "drive" "eyJzY29wZSI6ImRyaXZlLmZpbGUifQ"` (access
//    only to files this backup creates, nothing else in the account).
// 3. Makes two random encryption passwords and writes Ledger's own rclone
//    config (storage/offsite/rclone.conf, readable by this user only).
// 4. Tests it: uploads a small file, reads it back, removes it.
// 5. Prints the two passwords — save them outside the server. Without them
//    the backups on Drive can't be opened.
// 6. Adds the nightly job to cron (03:00 Tashkent time), replacing the old
//    local-only one.
//
// It refuses to run again once set up (new passwords would leave the old
// backups unreadable) unless given --force.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { execFileSync } = require("child_process");
const { rclone, rcloneConfig, offsiteDir, REMOTE } = require("../src/services/backup");

const ask = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

// Letters and digits only: a password starting with "-" would be read by
// rclone as an option.
const password = () => crypto.randomBytes(24).toString("hex");

// The token rclone authorize prints: either the token JSON itself (older
// rclone), or — newer rclone — a base64 blob of { client_id, client_secret,
// token: "<the token JSON>" }. Returns the token (with a refresh_token) or null.
function parseToken(raw) {
  const tryJson = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const text = String(raw || "").replace(/--->|<---End paste/g, "").trim();
  let obj = text.includes("{") ? tryJson(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) : null;
  if (!obj) obj = tryJson(Buffer.from(text.replace(/[^A-Za-z0-9+/=_-]/g, ""), "base64").toString("utf8"));
  if (obj && typeof obj.token === "string") obj = tryJson(obj.token);
  return obj && typeof obj.refresh_token === "string" && obj.refresh_token ? obj : null;
}

async function main() {
  const conf = rcloneConfig();
  if (fs.existsSync(conf) && !process.argv.includes("--force")) {
    console.log(`Already set up (${conf}).`);
    console.log("Running it again would make new passwords and leave the existing backups unreadable.");
    console.log("If you really mean to start over: npm run backup:offsite-setup -- --force");
    return;
  }

  // 1. rclone
  try {
    const version = await rclone(["version"], { withConfig: false, timeoutMs: 20000 });
    console.log(`rclone: ${version.split("\n")[0]}`);
  } catch {
    console.log("rclone isn't installed. Install it first:\n\n  sudo apt update && sudo apt install -y rclone\n\nthen run this again.");
    process.exitCode = 1;
    return;
  }

  // 2. The token
  console.log("\nOn your own computer (with a browser), run:\n");
  console.log('  rclone authorize "drive" "eyJzY29wZSI6ImRyaXZlLmZpbGUifQ"\n');
  console.log("Sign in with the backup Google account and allow access. It then prints the");
  console.log("token: a long line (newer rclone: between ---> and <---End paste; older: one");
  console.log('starting with {"access_token":). Paste it here and press Enter.\n');
  const token = parseToken(await ask("Token: "));
  if (!token) {
    console.log("\nThat doesn't look like the token (it needs a refresh_token). Nothing was saved — run this again.");
    process.exitCode = 1;
    return;
  }

  // 3. Passwords and the config
  const pass1 = password();
  const pass2 = password();
  const obscure = async (p) => (await rclone(["obscure", p], { withConfig: false })).trim();
  const text = [
    "# Ledger's backup remotes (npm run backup:offsite-setup). Keep this file private.",
    "[gdrive]",
    "type = drive",
    "scope = drive.file",
    `token = ${JSON.stringify(token)}`,
    "",
    `[${REMOTE}]`,
    "type = crypt",
    "remote = gdrive:ledger-backups",
    "filename_encryption = standard",
    "directory_name_encryption = true",
    `password = ${await obscure(pass1)}`,
    `password2 = ${await obscure(pass2)}`,
    "",
  ].join("\n");
  fs.mkdirSync(offsiteDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(conf, text, { mode: 0o600 });

  // 4. Test
  const probe = path.join(offsiteDir(), "probe.txt");
  const stamp = new Date().toISOString();
  fs.writeFileSync(probe, `Ledger backup test ${stamp}\n`);
  try {
    await rclone(["copyto", probe, `${REMOTE}:test/probe.txt`], { timeoutMs: 120000 });
    const back = await rclone(["cat", `${REMOTE}:test/probe.txt`], { timeoutMs: 120000 });
    if (!back.includes(stamp)) throw new Error("the file read back from Drive didn't match");
    await rclone(["purge", `${REMOTE}:test`], { timeoutMs: 120000 });
    console.log("\nTest: uploaded, read back and removed a test file — Google Drive works, encrypted.");
  } catch (err) {
    fs.rmSync(conf, { force: true });
    console.log(`\nThe test failed, so nothing was kept: ${err.message}`);
    console.log("Check the token (right Google account? copied whole?) and run this again.");
    process.exitCode = 1;
    return;
  } finally {
    fs.rmSync(probe, { force: true });
  }

  // 5. The passwords
  console.log("\n==================================================================");
  console.log(" SAVE THESE TWO PASSWORDS OUTSIDE THE SERVER (password manager, or");
  console.log(" on paper in a safe place). Without them the backups can't be opened.");
  console.log("==================================================================");
  console.log(`  password:  ${pass1}`);
  console.log(`  password2: ${pass2}`);
  console.log("==================================================================\n");

  // 6. Cron
  const node = process.execPath;
  const dir = path.resolve(__dirname, "..");
  const logFile = path.join(path.dirname(offsiteDir()), "backups", "backup.log");
  // 03:00 in Tashkent (UTC+5), in the server's own clock (a VPS is usually UTC).
  const serverOffset = -new Date().getTimezoneOffset() / 60;
  const hour = (((3 - 5 + serverOffset) % 24) + 24) % 24;
  const line = `0 ${hour} * * * cd ${dir} && ${node} scripts/offsite-backup.js >> ${logFile} 2>&1`;
  let current = "";
  try {
    current = execFileSync("crontab", ["-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    current = "";
  }
  const kept = current
    .split("\n")
    .filter((l) => l.trim() && !l.includes("scripts/backup-db.js") && !l.includes("scripts/offsite-backup.js"));
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    execFileSync("crontab", ["-"], { input: [...kept, line, ""].join("\n") });
    console.log("Nightly backup added to cron (03:00 Tashkent time):");
    console.log(`  ${line}\n`);
  } catch (err) {
    console.log(`Couldn't add it to cron (${err.message}). Add this line with "crontab -e":\n  ${line}\n`);
  }
  console.log("Now run the first backup (it also uploads the recordings, so it can take a while):\n");
  console.log("  npm run backup:offsite\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
