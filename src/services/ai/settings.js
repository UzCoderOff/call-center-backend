const crypto = require("crypto");
const env = require("../../config/env");
const { getSetting, setSetting } = require("../../lib/settings");

// Ledger AI's settings (Sozlamalar → Sunʼiy intellekt, developer): the
// OpenAI API key, the model, and how many questions a person may ask a day.
// The key is pasted in the portal by the developer — never sent in a chat —
// and kept in the database encrypted with a key derived from JWT_SECRET (so
// a copy of the database alone, like the off-site backup, can't read it).
// It's never sent back: the portal only sees its last four characters.

const AI_DEFAULTS = {
  enabled: true,
  model: "gpt-5-mini",
  dailyLimit: 60,
  keyEnc: null,
  keyLast4: null,
  keySetAt: null,
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
  return { enabled: s.enabled, model: s.model, dailyLimit: s.dailyLimit, hasKey: Boolean(s.keyEnc), keyLast4: s.keyLast4, keySetAt: s.keySetAt };
}

async function saveAiSettings(changes, userId) {
  const current = await aiSettings();
  const next = { ...current };
  if (changes.enabled !== undefined) next.enabled = Boolean(changes.enabled);
  if (changes.model !== undefined) next.model = String(changes.model).trim().slice(0, 60) || AI_DEFAULTS.model;
  if (changes.dailyLimit !== undefined) next.dailyLimit = Math.max(1, Math.min(1000, Math.round(Number(changes.dailyLimit) || AI_DEFAULTS.dailyLimit)));
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

module.exports = { AI_DEFAULTS, aiSettings, publicAiSettings, saveAiSettings, apiKey, recordUsage, usageNow, seal, open };
