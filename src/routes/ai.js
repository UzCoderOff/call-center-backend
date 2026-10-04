const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { publicAiSettings, saveAiSettings, apiKey, aiSettings, usageNow } = require("../services/ai/settings");
const { listModels, OpenAiError } = require("../services/ai/openai");

// Ledger AI's settings (Sozlamalar → Sunʼiy intellekt) — developer only.
//
//   GET  /api/ai/settings   on/off, model, daily limit, whether a key is set
//                           (its last 4 characters only), this month's use
//   PUT  /api/ai/settings   { enabled?, model?, dailyLimit?, apiKey? } —
//                           apiKey "" removes it
//   POST /api/ai/test       checks the key with OpenAI: works? the models it
//                           may use, and whether the chosen one is among them
const router = express.Router();
router.use(requireAuth, requireRole("DEVELOPER"));

router.get("/settings", async (req, res, next) => {
  try {
    res.json({ ...(await publicAiSettings()), usage: await usageNow() });
  } catch (err) {
    next(err);
  }
});

router.put("/settings", async (req, res, next) => {
  try {
    const b = req.body || {};
    const saved = await saveAiSettings(
      { enabled: b.enabled, model: b.model, dailyLimit: b.dailyLimit, apiKey: typeof b.apiKey === "string" ? b.apiKey : undefined },
      req.user.id
    );
    res.json({ ...saved, usage: await usageNow() });
  } catch (err) {
    next(err);
  }
});

// Chat models only — not audio, images, embeddings and the like.
const CHAT_MODEL = /^(gpt-|o\d|chatgpt-)/;
const NOT_CHAT = /(audio|realtime|transcribe|tts|image|embedding|search|moderation|instruct|codex|computer-use|dall-e|whisper)/;

router.post("/test", async (req, res, next) => {
  try {
    const key = await apiKey();
    if (!key) return res.json({ ok: false, error: "no_key" });
    const { model } = await aiSettings();
    try {
      const models = (await listModels(key)).filter((m) => CHAT_MODEL.test(m) && !NOT_CHAT.test(m));
      res.json({ ok: true, models, modelAvailable: models.includes(model) });
    } catch (err) {
      if (!(err instanceof OpenAiError)) throw err;
      res.json({ ok: false, error: err.status === 401 ? "bad_key" : "openai", message: err.message });
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
