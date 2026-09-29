const env = require("../../config/env");

// The Telegram Bot API over plain HTTPS (Node's own fetch) — no extra
// package. The token is part of every URL, so URLs are never logged: errors
// name the method only.

class TelegramError extends Error {
  constructor(method, status, body) {
    super(`telegram ${method} failed: ${body?.description || `HTTP ${status}`}`);
    this.method = method;
    this.status = status;
    this.code = body?.error_code ?? status;
    this.retryAfter = body?.parameters?.retry_after ?? null;
    this.description = body?.description || "";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method, params = {}, { timeoutMs = 15000 } = {}) {
  if (!env.telegram.token) throw new Error("telegram_not_configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${env.telegram.apiUrl}/bot${env.telegram.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
  } catch (err) {
    // Network trouble or our own timeout — without the URL in the message.
    const e = new Error(`telegram ${method}: ${err.name === "AbortError" ? "timed out" : "network error"}`);
    e.network = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => null);
  if (!body?.ok) throw new TelegramError(method, res.status, body);
  return body.result;
}

// The person blocked the bot, deleted their account, or the chat is gone —
// stop sending there.
function chatIsGone(err) {
  return err instanceof TelegramError && (err.code === 403 || (err.code === 400 && /chat not found|user is deactivated/i.test(err.description)));
}

// Messages go out one at a time, a little apart: Telegram allows about 30
// a second overall and one a second per chat, and answers "retry after N
// seconds" when a bot sends faster — which is waited out here.
const queue = [];
let draining = false;

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      try {
        job.resolve(await call(job.method, job.params));
      } catch (err) {
        if (err.retryAfter && job.tries < 3) {
          job.tries += 1;
          queue.unshift(job);
          await sleep(err.retryAfter * 1000);
          continue;
        }
        if (err.network && job.tries < 2) {
          job.tries += 1;
          queue.push(job);
          await sleep(2000);
          continue;
        }
        job.reject(err);
      }
      await sleep(60);
    }
  } finally {
    draining = false;
  }
}

function enqueue(method, params) {
  return new Promise((resolve, reject) => {
    queue.push({ method, params, resolve, reject, tries: 0 });
    drain();
  });
}

// HTML formatting: callers escape anything that came from people (names,
// notes) with escapeHtml in ./format.js.
function sendMessage(chatId, text, extra = {}) {
  return enqueue("sendMessage", {
    chat_id: chatId,
    text: text.length > 4000 ? `${text.slice(0, 3990)}…` : text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

module.exports = { call, enqueue, sendMessage, chatIsGone, TelegramError, sleep };
