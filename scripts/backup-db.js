// A dated copy of the database: storage/backups/ledger-YYYY-MM-DD.db, the
// last 14 kept. Safe while the server runs (src/services/backup.js).
//
//   npm run backup
//
// Every night, with the copy to Google Drive as well: npm run backup:offsite
// (see DEPLOY.md, "Backups").
require("dotenv").config();
const prisma = require("../src/lib/prisma");
const { makeLocalBackup } = require("../src/services/backup");

makeLocalBackup()
  .then(({ file, size, removed }) => {
    console.log(`backup: ${file} (${Math.round(size / 1024)} KB)${removed ? `, removed ${removed} old` : ""}`);
  })
  .catch((err) => {
    console.error(`backup failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
