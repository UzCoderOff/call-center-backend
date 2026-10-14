const crypto = require("crypto");
const env = require("../../config/env");
const { getSetting, setSetting } = require("../../lib/settings");

// Ledger AI's settings (Sozlamalar → Sunʼiy intellekt, developer): the
// OpenAI API key, the model, and how many questions a person may ask a day;
// and Claude (Anthropic, 2026-10-14) — its key (from the Console
// organization the Max plan's monthly API credit goes to), which one answers
// in the Ledger AI chat, its model, the features it powers (each off until
// switched on) and a monthly spending cap.
// The key is pasted in the portal by the developer — never sent in a chat —
// and kept in the database encrypted with a key derived from JWT_SECRET (so
// a copy of the database alone, like the off-site backup, can't read it).
// It's never sent back: the portal only sees its last four characters.

// What Claude powers (services/ai/reports.js, fileReader.js, consultSummary).
const CLAUDE_FEATURES = ["weeklyReport", "lostAnalysis", "suggestions", "fileReader", "summaryDraft"];

const AI_DEFAULTS = {
  enabled: true,
  model: "gpt-5-mini",
  dailyLimit: 60,
  keyEnc: null,
  keyLast4: null,
  keySetAt: null,
  // Who answers in the Ledger AI chat: "openai" | "claude".
  provider: "openai",
  claudeKeyEnc: null,
  claudeKeyLast4: null,
  claudeKeySetAt: null,
  claudeModel: "claude-opus-5-5",
  claudeFeatures: Object.fromEntries(CLAUDE_FEATURES.map((f) => [f, false])),
  // The reports' script: "latin" | "cyrillic".
  reportScript: "latin",
  // Ledger stops calling Claude for the month past this (USD); 0: no cap.
  claudeMonthlyCapUsd: 80,
};

function cipherKey() {
  if (!env.jwtSecret) throw new Error("JWT_SECRET is not set");
  return Buffer.from(crypto.hkdfSync("sha256", env.jwtSecret, "ledger", "openai-api-key", 32));
}

// AES-256-GCM: "iv.tag.ciphertext", base64url each.
function seal(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", cipherKey(), iv);
  const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

function open(sealed) {
  const [iv, tag, data] = String(sealed).split(".").map((s) => Buffer.from(s, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", cipherKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

const aiSettings = () => getSetting("ai", AI_DEFAULTS);

// What the portal may see.
async function publicAiSettings() {
  const s = await aiSettings();
  return {
    enabled: s.enabled,
    model: s.model,
    dailyLimit: s.dailyLimit,
    hasKey: Boolean(s.keyEnc),
    keyLast4: s.keyLast4,
    keySetAt: s.keySetAt,
    provider: s.provider,
    hasClaudeKey: Boolean(s.claudeKeyEnc),
    claudeKeyLast4: s.claudeKeyLast4,
    claudeKeySetAt: s.claudeKeySetAt,
    claudeModel: s.claudeModel,
    claudeFeatures: { ...AI_DEFAULTS.claudeFeatures, ...(s.claudeFeatures || {}) },
    reportScript: s.reportScript,
    claudeMonthlyCapUsd: s.claudeMonthlyCapUsd,
  };
}

async function saveAiSettings(changes, userId) {
  const current = await aiSettings();
  const next = { ...current };
  if (changes.enabled !== undefined) next.enabled = Boolean(changes.enabled);
  if (changes.model !== undefined) next.model = String(changes.model).trim().slice(0, 60) || AI_DEFAULTS.model;
  if (changes.dailyLimit !== undefined) next.dailyLimit = Math.max(1, Math.min(1000, Math.round(Number(changes.dailyLimit) || AI_DEFAULTS.dailyLimit)));
  if (changes.provider !== undefined) next.provider = changes.provider === "claude" ? "claude" : "openai";
  if (changes.claudeModel !== undefined) next.claudeModel = String(changes.claudeModel).trim().slice(0, 60) || AI_DEFAULTS.claudeModel;
  if (changes.reportScript !== undefined) next.reportScript = changes.reportScript === "cyrillic" ? "cyrillic" : "latin";
  if (changes.claudeMonthlyCapUsd !== undefined) next.claudeMonthlyCapUsd = Math.max(0, Math.min(10000, Math.round((Number(changes.claudeMonthlyCapUsd) || 0) * 100) / 100));
  if (changes.claudeFeatures && typeof changes.claudeFeatures === "object") {
    const current = { ...AI_DEFAULTS.claudeFeatures, ...(next.claudeFeatures || {}) };
    for (const f of CLAUDE_FEATURES) if (changes.claudeFeatures[f] !== undefined) current[f] = Boolean(changes.claudeFeatures[f]);
    next.claudeFeatures = current;
  }
  if (changes.claudeKey !== undefined) {
    const key = String(changes.claudeKey || "").trim();
    if (key) {
      next.claudeKeyEnc = seal(key);
      next.claudeKeyLast4 = key.slice(-4);
      next.claudeKeySetAt = new Date().toISOString();
    } else {
      next.claudeKeyEnc = null;
      next.claudeKeyLast4 = null;
      next.claudeKeySetAt = null;
    }
  }
  if (changes.apiKey !== undefined) {
    const key = String(changes.apiKey || "").trim();
    if (key) {
      next.keyEnc = seal(key);
      next.keyLast4 = key.slice(-4);
      next.keySetAt = new Date().toISOString();
    } else {
      next.keyEnc = null;
      next.keyLast4 = null;
      next.keySetAt = null;
    }
  }
  await setSetting("ai", next, userId);
  return publicAiSettings();
}

// The key itself, for calling OpenAI — null when none is set.
async function apiKey() {
  const s = await aiSettings();
  if (!s.keyEnc) return null;
  try {
    return open(s.keyEnc);
  } catch {
    return null; // JWT_SECRET changed: paste the key again
  }
}

// Claude's key, for calling Anthropic — null when none is set.
async function claudeKey() {
  const s = await aiSettings();
  if (!s.claudeKeyEnc) return null;
  try {
    return open(s.claudeKeyEnc);
  } catch {
    return null; // JWT_SECRET changed: paste the key again
  }
}

// Whether a Claude feature is switched on (and there's a key).
async function claudeFeatureOn(feature) {
  const s = await aiSettings();
  return Boolean(s.claudeKeyEnc) && Boolean({ ...AI_DEFAULTS.claudeFeatures, ...(s.claudeFeatures || {}) }[feature]);
}

// What Claude cost, per month and per feature (USD, from its token counts):
// { "2026-10": { usd, calls, byFeature: { weeklyReport: { usd, calls } } } }.
async function recordClaudeUsage(month, feature, usd) {
  const all = await getSetting("claudeUsage", {});
  const m = all[month] || { usd: 0, calls: 0, byFeature: {} };
  const f = m.byFeature[feature] || { usd: 0, calls: 0 };
  const months = { ...all, [month]: { usd: m.usd + usd, calls: m.calls + 1, byFeature: { ...m.byFeature, [feature]: { usd: f.usd + usd, calls: f.calls + 1 } } } };
  const kept = Object.fromEntries(Object.entries(months).sort(([a], [b]) => b.localeCompare(a)).slice(0, 12));
  await setSetting("claudeUsage", kept, null);
}

async function claudeUsageNow() {
  const { firmDate } = require("../../lib/firmTime");
  const month = firmDate().slice(0, 7);
  const all = await getSetting("claudeUsage", {});
  return { month, ...(all[month] || { usd: 0, calls: 0, byFeature: {} }) };
}

// What Ledger AI has used, per month (for the developer to keep an eye on
// the OpenAI balance): { "2026-10": { questions, input, output } }.
async function recordUsage(month, { input = 0, output = 0 }) {
  const all = await getSetting("aiUsage", {});
  const m = all[month] || { questions: 0, input: 0, output: 0 };
  const months = { ...all, [month]: { questions: m.questions + 1, input: m.input + input, output: m.output + output } };
  // Keep the last twelve months.
  const kept = Object.fromEntries(Object.entries(months).sort(([a], [b]) => b.localeCompare(a)).slice(0, 12));
  await setSetting("aiUsage", kept, null);
}

async function usageNow() {
  const { firmDate } = require("../../lib/firmTime");
  const month = firmDate().slice(0, 7);
  const all = await getSetting("aiUsage", {});
  return { month, ...(all[month] || { questions: 0, input: 0, output: 0 }) };
}

module.exports = { AI_DEFAULTS, CLAUDE_FEATURES, aiSettings, publicAiSettings, saveAiSettings, apiKey, claudeKey, claudeFeatureOn, recordUsage, usageNow, recordClaudeUsage, claudeUsageNow, seal, open };
