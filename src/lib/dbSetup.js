const prisma = require("./prisma");

// Run once at startup: WAL journal, so reading (lists, reports) and saving
// don't block each other. The mode is stored in the database file, so this
// is idempotent. (A save that meets another save already waits: Prisma sets
// a 5-second busy timeout on every SQLite connection.)
async function prepareDatabase() {
  const [{ journal_mode: mode }] = await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL;");
  console.log(`database: journal mode ${mode}`);
}

module.exports = { prepareDatabase };
