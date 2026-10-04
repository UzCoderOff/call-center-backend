const { evaluateStrikes } = require("./strikes");
const { archiveQuietClients } = require("./clientArchive");

// Work done on a clock, whatever else is configured (the Telegram bot has its
// own clock for messages — src/services/telegram/jobs.js):
//   every 5 minutes  late call-back strikes (services/strikes.js)
//   every hour       consultations gone quiet to the archive (services/clientArchive.js)
// Each run waits for the previous one; an error is logged, never thrown.

const STRIKES_EVERY_MS = 5 * 60 * 1000;
let running = false;

async function strikesTick() {
  if (running) return;
  running = true;
  try {
    const { created, cancelled } = await evaluateStrikes();
    if (created || cancelled) console.log(`[strikes] ${created} given, ${cancelled} cancelled (call-back found)`);
  } catch (err) {
    console.error("[strikes] check failed:", err.message);
  } finally {
    running = false;
  }
}

const ARCHIVE_EVERY_MS = 60 * 60 * 1000;
let archiving = false;

async function archiveTick() {
  if (archiving) return;
  archiving = true;
  try {
    const n = await archiveQuietClients();
    if (n) console.log(`[clients] ${n} quiet consultation(s) moved to the archive`);
  } catch (err) {
    console.error("[clients] automatic archive failed:", err.message);
  } finally {
    archiving = false;
  }
}

function start() {
  setTimeout(strikesTick, 30 * 1000).unref();
  setInterval(strikesTick, STRIKES_EVERY_MS).unref();
  setTimeout(archiveTick, 60 * 1000).unref();
  setInterval(archiveTick, ARCHIVE_EVERY_MS).unref();
}

module.exports = { start, strikesTick, archiveTick };
