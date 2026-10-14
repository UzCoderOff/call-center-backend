const { evaluateStrikes } = require("./strikes");
const { evaluateSummaryStrikes } = require("./consultSummary");
const { archiveQuietClients } = require("./clientArchive");
const { syncDueStages } = require("./caseHistory");
const prisma = require("../lib/prisma");
const { firmNow } = require("../lib/firmTime");

// Work done on a clock, whatever else is configured (the Telegram bot has its
// own clock for messages — src/services/telegram/jobs.js):
//   every 5 minutes  late call-back strikes (services/strikes.js), and
//                    consultation summaries not written in time
//                    (services/consultSummary.js)
//   every hour       consultations gone quiet to the archive (services/clientArchive.js);
//                    planned case stages whose day has come (services/caseHistory.js)
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
  }
  try {
    const { created } = await evaluateSummaryStrikes();
    if (created) console.log(`[summaries] ${created} strike(s) for summaries not written in time`);
  } catch (err) {
    console.error("[summaries] check failed:", err.message);
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
  }
  try {
    const n = await syncDueStages(prisma, firmNow().date);
    if (n) console.log(`[cases] ${n} case(s) reached a planned stage`);
  } catch (err) {
    console.error("[cases] planned stages failed:", err.message);
  } finally {
    archiving = false;
  }
}

// Claude's reports on their days (services/ai/reports.js) — each only when
// switched on in Sozlamalar.
const AI_EVERY_MS = 5 * 60 * 1000;
let reporting = false;

async function aiTick() {
  if (reporting) return;
  reporting = true;
  try {
    await require("./ai/reports").tick();
  } catch (err) {
    console.error("[claude] scheduled report failed:", err.message);
  } finally {
    reporting = false;
  }
}

function start() {
  setTimeout(aiTick, 90 * 1000).unref();
  setInterval(aiTick, AI_EVERY_MS).unref();
  setTimeout(strikesTick, 30 * 1000).unref();
  setInterval(strikesTick, STRIKES_EVERY_MS).unref();
  setTimeout(archiveTick, 60 * 1000).unref();
  setInterval(archiveTick, ARCHIVE_EVERY_MS).unref();
}

module.exports = { start, strikesTick, archiveTick, aiTick };
