const env = require("../../config/env");
const bot = require("./bot");
const jobs = require("./jobs");
const listeners = require("./listeners");

// Staff notifications (listeners.js for things happening in the portal,
// jobs.js for the clock) — on Telegram and in the Ledger app — and the
// Telegram bot's chat itself (bot.js). The notifications run when either
// channel is set up (TELEGRAM_BOT_TOKEN, or Google push for the app); the
// bot only with its token. Started from server.js — not from app.js, so
// tests and scripts that load the app never talk to Telegram.
function start() {
  const telegram = Boolean(env.telegram.token);
  if (!telegram) console.log("[telegram] no TELEGRAM_BOT_TOKEN — the staff bot is off");
  if (!telegram && !require("../notify").configured()) return;
  listeners.register();
  jobs.start();
  if (telegram) bot.start().catch((err) => console.error("[telegram] start failed:", err.message));
}

function status() {
  return {
    configured: Boolean(env.telegram.token),
    username: bot.state.username,
    status: env.telegram.token ? bot.state.status : "off",
    error: bot.state.error,
  };
}

module.exports = { start, status };
