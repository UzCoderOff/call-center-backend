const AnthropicModule = require("@anthropic-ai/sdk");
const { firmNow } = require("../../lib/firmTime");
const { aiSettings, claudeKey, recordClaudeUsage, claudeUsageNow } = require("./settings");

// Claude (Anthropic) for Ledger — every call goes through here: the key from
// Sozlamalar (the Console organization the Max plan's monthly API credit goes
// to), the month's spending cap, refusal fallbacks, prompt caching, and what
// each call cost (by feature, shown in Sozlamalar).
//
// Claude Opus / Sonnet requests carry `fallbacks: "default"`: if Claude's
// safety classifiers decline a request, Anthropic re-runs it on the model it
// recommends inside the same call. Claude Haiku has no server-side fallback.

const Anthropic = AnthropicModule.default || AnthropicModule;
const WITH_FALLBACKS = /^claude-(opus|sonnet|fable)-/;

// USD per 1M tokens: input, output, cache read (prompts up to 100K tokens
// for Haiku). Cache writes cost 1.25x input.
const PRICES = {
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01 },
};

class ClaudeError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
    this.status = 409;
  }
}

function priceOf(model) {
  const key = Object.keys(PRICES).find((k) => model === k || String(model).startsWith(`${k}-`));
  return PRICES[key] || PRICES["claude-opus-5-5"];
}

// What one answer cost (USD).
function costOf(model, usage) {
  if (!usage) return 0;
  const p = priceOf(model);
  return (
    ((usage.input_tokens || 0) * p.in + (usage.cache_creation_input_tokens || 0) * p.in * 1.25 + (usage.cache_read_input_tokens || 0) * p.cacheRead + (usage.output_tokens || 0) * p.out) / 1e6
  );
}

async function client() {
  const key = await claudeKey();
  if (!key) throw new ClaudeError("claude_off", "Claude key isn't set (Sozlamalar → Sunʼiy intellekt)");
  // A stand-in for tests: ANTHROPIC_BASE_URL (the SDK reads it).
  return new Anthropic({ apiKey: key, timeout: 180 * 1000, maxRetries: 2 });
}

async function underCap() {
  const s = await aiSettings();
  if (!s.claudeMonthlyCapUsd) return true;
  const used = await claudeUsageNow();
  return used.usd < s.claudeMonthlyCapUsd;
}

// One request to Claude. `feature` names what it's for (the cost table);
// `params` is a Messages API request (model defaults to the chosen one).
async function create(params, { feature }) {
  if (!(await underCap())) throw new ClaudeError("claude_cap", "Claude's monthly cap is reached (Sozlamalar → Sunʼiy intellekt)");
  const s = await aiSettings();
  const c = await client();
  const body = { model: s.claudeModel, max_tokens: 16000, cache_control: { type: "ephemeral" }, ...params };
  const response = WITH_FALLBACKS.test(body.model)
    ? await c.beta.messages.create({ ...body, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
    : await c.messages.create(body);
  const usd = costOf(response.model || body.model, response.usage);
  await recordClaudeUsage(firmNow().date.slice(0, 7), feature, usd).catch(() => {});
  console.log(`[claude] ${feature}: ${response.usage?.input_tokens ?? 0} in / ${response.usage?.output_tokens ?? 0} out, $${usd.toFixed(4)} (${response.model || body.model})`);
  return response;
}

// The words of an answer.
const textOf = (response) =>
  (response.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

// An answer asked for as JSON (output_config.format) — parsed, or null when
// it was declined or cut off.
function jsonOf(response) {
  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") return null;
  try {
    return JSON.parse(textOf(response));
  } catch {
    return null;
  }
}

// Sozlamalar → "Tekshirish": does the key work, and which of the models it
// may use.
async function check() {
  try {
    const c = await client();
    const ids = [];
    for await (const m of c.models.list()) ids.push(m.id);
    const s = await aiSettings();
    return { ok: true, models: ids.filter((id) => /^claude-/.test(id)), modelAvailable: ids.includes(s.claudeModel) };
  } catch (err) {
    if (err instanceof ClaudeError) return { ok: false, error: "no_key" };
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, error: "bad_key", message: err.message };
    if (err instanceof Anthropic.APIError) return { ok: false, error: "anthropic", message: err.message };
    throw err;
  }
}

// A short Uzbek explanation for the person when a call fails.
function explain(err) {
  if (err instanceof ClaudeError && err.code === "claude_cap") return "Claude uchun shu oyga belgilangan chegara tugadi (Sozlamalar → Sunʼiy intellekt).";
  if (err instanceof ClaudeError) return "Claude kaliti kiritilmagan: dasturchi Sozlamalar → Sunʼiy intellekt boʻlimida kiritishi kerak.";
  if (err instanceof Anthropic.AuthenticationError) return "Claude kaliti notoʻgʻri yoki oʻchirilgan — Sozlamalarda yangisini kiriting.";
  if (err instanceof Anthropic.RateLimitError) return "Claude hozir band — bir daqiqadan soʻng qayta urinib koʻring.";
  if (err instanceof Anthropic.APIError && /credit balance/i.test(err.message)) return "Claude hisobidagi kredit tugadi — keyingi oy kelguncha yoki Console'da toʻldirguncha ishlamaydi.";
  return "Claude javob bermadi. Birozdan soʻng qayta urinib koʻring.";
}

module.exports = { create, textOf, jsonOf, check, explain, costOf, ClaudeError, Anthropic, PRICES };
