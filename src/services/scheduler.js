const { evaluateStrikes } = require("./strikes");

// Work done on a clock, whatever else is configured (the Telegram bot has its
// own clock for messages — src/services/telegram/jobs.js):
//   every 5 minutes  late call-back strikes (services/strikes.js)
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

function start() {
  setTimeout(strikesTick, 30 * 1000).unref();
  setInterval(strikesTick, STRIKES_EVERY_MS).unref();
}

module.exports = { start, strikesTick };
