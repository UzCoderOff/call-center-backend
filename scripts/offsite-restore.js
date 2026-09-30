// Getting a backup back from Google Drive (DEPLOY.md, "Backups").
//
//   npm run backup:restore                            list what's on Drive
//   npm run backup:restore -- ledger-2026-10-01.db    download that day's copy
//   npm run backup:restore -- ledger-2026-09.db       …or a month's last copy
//
// It only downloads (decrypted) into storage/backups/restored/ and checks the
// file — it never touches the live database. Putting it in place is a
// deliberate step, printed at the end.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { rclone, offsiteConfigured, backupsDir, REMOTE } = require("../src/services/backup");

async function main() {
  if (!offsiteConfigured()) {
    console.log("Google Drive backup isn't set up on this machine (npm run backup:offsite-setup).");
    process.exitCode = 1;
    return;
  }
  const name = process.argv[2];
  if (!name) {
    const daily = (await rclone(["lsf", `${REMOTE}:daily`])).split("\n").filter(Boolean).sort();
    const monthly = (await rclone(["lsf", `${REMOTE}:monthly`])).split("\n").filter(Boolean).sort();
    console.log(`Daily (${daily.length}):\n  ${daily.join("\n  ") || "—"}`);
    console.log(`Monthly (${monthly.length}):\n  ${monthly.join("\n  ") || "—"}`);
    console.log("\nDownload one: npm run backup:restore -- <name>");
    return;
  }
  if (!/^ledger-\d{4}-\d{2}(-\d{2})?\.db$/.test(name)) {
    console.log("Give a name from the list, e.g. ledger-2026-10-01.db");
    process.exitCode = 1;
    return;
  }
  const folder = name.length === "ledger-YYYY-MM.db".length ? "monthly" : "daily";
  const dir = path.join(backupsDir(), "restored");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, name);
  await rclone(["copyto", `${REMOTE}:${folder}/${name}`, target]);
  fs.chmodSync(target, 0o600);

  const copy = new PrismaClient({ datasources: { db: { url: `file:${target}?mode=ro` } } });
  try {
    const [check] = (await copy.$queryRawUnsafe("PRAGMA quick_check")).map((r) => Object.values(r)[0]);
    const [{ n }] = await copy.$queryRawUnsafe("SELECT COUNT(*) AS n FROM Client");
    console.log(`Downloaded: ${target}`);
    console.log(`Check: ${check} · clients in it: ${n}`);
  } finally {
    await copy.$disconnect();
  }
  console.log("\nTo put it in place of the live database (only if you mean to):");
  console.log("  pm2 stop all");
  console.log("  npm run backup                      # a copy of the current one first");
  console.log(`  cp ${target} <the database file in DATABASE_URL, e.g. prisma/dev.db>`);
  console.log("  rm -f prisma/dev.db-wal prisma/dev.db-shm   # the old one's leftovers, if there");
  console.log("  pm2 restart all");
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
