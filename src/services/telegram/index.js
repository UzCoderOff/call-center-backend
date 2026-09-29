const env = require("../../config/env");
const bot = require("./bot");
const jobs = require("./jobs");
const listeners = require("./listeners");

// The staff Telegram bot: notifications (listeners.js for things happening
// in the portal, jobs.js for the clock) and the chat itself (bot.js).
// Nothing starts without TELEGRAM_BOT_TOKEN. Started from server.js — not
// from app.js, so tests and scripts that load the app never talk to
// Telegram.
function start() {
  if (!env.telegram.token) {
    console.log("[telegram] no TELEGRAM_BOT_TOKEN — the staff bot is off");
    return;
  }
  listeners.register();
  jobs.start();
  bot.start().catch((err) => console.error("[telegram] start failed:", err.message));
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
