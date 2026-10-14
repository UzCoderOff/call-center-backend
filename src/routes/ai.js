const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { publicAiSettings, saveAiSettings, apiKey, aiSettings, usageNow, claudeUsageNow } = require("../services/ai/settings");
const { listModels, OpenAiError } = require("../services/ai/openai");

// Ledger AI's settings (Sozlamalar → Sunʼiy intellekt) — developer only.
//
//   GET  /api/ai/settings   on/off, model, daily limit, whether a key is set
//                           (its last 4 characters only), this month's use
//   PUT  /api/ai/settings   { enabled?, model?, dailyLimit?, apiKey? } —
//                           apiKey "" removes it
//   POST /api/ai/test       checks the key with OpenAI: works? the models it
//                           may use, and whether the chosen one is among them
//   POST /api/ai/test-claude  checks the Claude key with Anthropic
//   POST /api/ai/run/:job   runs a Claude job now: weeklyReport | lostAnalysis | suggestions
const router = express.Router();
router.use(requireAuth, requireRole("DEVELOPER"));

router.get("/settings", async (req, res, next) => {
  try {
    res.json({ ...(await publicAiSettings()), usage: await usageNow(), claudeUsage: await claudeUsageNow() });
  } catch (err) {
    next(err);
  }
});

router.put("/settings", async (req, res, next) => {
  try {
    const b = req.body || {};
    const saved = await saveAiSettings(
      {
        enabled: b.enabled,
        model: b.model,
        dailyLimit: b.dailyLimit,
        apiKey: typeof b.apiKey === "string" ? b.apiKey : undefined,
        provider: b.provider,
        claudeModel: b.claudeModel,
        claudeFeatures: b.claudeFeatures,
        reportScript: b.reportScript,
        claudeMonthlyCapUsd: b.claudeMonthlyCapUsd,
        claudeKey: typeof b.claudeKey === "string" ? b.claudeKey : undefined,
      },
      req.user.id
    );
    res.json({ ...saved, usage: await usageNow(), claudeUsage: await claudeUsageNow() });
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

router.post("/test-claude", async (req, res, next) => {
  try {
    const claude = require("../services/ai/claude");
    res.json(await claude.check());
  } catch (err) {
    next(err);
  }
});

// A Claude job now (the developer trying it, or a report wanted early).
router.post("/run/:job", async (req, res, next) => {
  try {
    const reports = require("../services/ai/reports");
    const jobs = { weeklyReport: reports.weeklyReport, lostAnalysis: reports.lostAnalysis, suggestions: reports.suggestions };
    const job = jobs[req.params.job];
    if (!job) return res.status(404).json({ error: "unknown_job" });
    res.json(await job({ force: true, byUserId: req.user.id }));
  } catch (err) {
    if (err.code === "claude_off" || err.code === "claude_cap") return res.status(409).json({ error: err.code });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
