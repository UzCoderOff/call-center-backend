const prisma = require("./prisma");

// Firm-wide rules kept in the database (Setting: one row per key, the value
// as JSON), with their defaults in code — so a rule exists before anyone
// saves it, and a value saved by an older version gains new fields from the
// defaults. Read often, written rarely: cached for a minute.

const cache = new Map();
const TTL_MS = 60 * 1000;

async function getSetting(key, defaults, db = prisma) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...defaults, ...hit.value };
  const row = await db.setting.findUnique({ where: { key } });
  const value = row && row.value && typeof row.value === "object" && !Array.isArray(row.value) ? row.value : {};
  cache.set(key, { at: Date.now(), value });
  return { ...defaults, ...value };
}

async function setSetting(key, value, userId, db = prisma) {
  const row = await db.setting.upsert({ where: { key }, create: { key, value, updatedById: userId }, update: { value, updatedById: userId } });
  cache.set(key, { at: Date.now(), value });
  return row;
}

function clearSettingsCache() {
  cache.clear();
}

module.exports = { getSetting, setSetting, clearSettingsCache };
