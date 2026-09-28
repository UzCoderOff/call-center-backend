// A dated copy of the database: storage/backups/ledger-YYYY-MM-DD.db, the
// last 14 kept. Safe while the server runs — SQLite's VACUUM INTO writes a
// consistent snapshot. Run daily from cron (see DEPLOY.md):
//
//   npm run backup
//
// Recordings (storage/recordings) are plain files; back those up by copying
// the folder (e.g. rsync to another machine).
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const prisma = require("../src/lib/prisma");
const env = require("../src/config/env");
const { firmDate } = require("../src/lib/firmTime");

const KEEP = 14;

async function main() {
  const dir = path.join(path.dirname(env.storageRoot), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ledger-${firmDate()}.db`);
  // VACUUM INTO refuses to overwrite: today's earlier copy is replaced.
  fs.rmSync(file, { force: true });
  await prisma.$executeRawUnsafe(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const size = fs.statSync(file).size;

  const old = fs
    .readdirSync(dir)
    .filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .reverse()
    .slice(KEEP);
  for (const f of old) fs.rmSync(path.join(dir, f));

  console.log(`backup: ${file} (${Math.round(size / 1024)} KB)${old.length ? `, removed ${old.length} old` : ""}`);
}

main()
  .catch((err) => {
    console.error("backup failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
