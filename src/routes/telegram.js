const express = require("express");
const crypto = require("crypto");
const prisma = require("../lib/prisma");
const { requireAuth, requireRole, MANAGER_ROLES } = require("../middleware/auth");
const { badRequest } = require("../utils/params");
const telegram = require("../services/telegram");
const { hashCode } = require("../services/telegram/bot");
const { applicableKinds, effectivePrefs } = require("../services/telegram/prefs");
const { notifyUser } = require("../services/telegram/notify");
const api = require("../services/telegram/api");

// Connecting a person's Telegram to their account, and choosing which
// notifications come there.
//
//   GET    /api/telegram/me          connected? which notifications?
//   POST   /api/telegram/link        a one-time t.me link to press Start in
//   PATCH  /api/telegram/me/prefs    { appointments: false, … }
//   POST   /api/telegram/me/test     a test message
//   DELETE /api/telegram/me          disconnect
//   GET    /api/telegram/overview    managers: bot state, who is connected
const router = express.Router();
router.use(requireAuth);

const LINK_TTL_MS = 15 * 60 * 1000;

async function currentUser(req) {
  return prisma.user.findUnique({ where: { id: req.user.id }, include: { employee: true, calendar: true, telegram: true } });
}

function describe(user) {
  const bot = telegram.status();
  const link = user.telegram;
  const prefs = effectivePrefs(user, link?.prefs);
  return {
    bot: { configured: bot.configured, username: bot.username, ready: bot.configured && Boolean(bot.username) },
    connected: Boolean(link?.chatId),
    telegramName: link?.chatId ? link.telegramName : null,
    linkedAt: link?.chatId ? link.linkedAt : null,
    kinds: applicableKinds(user).map((key) => ({ key, on: prefs[key] })),
  };
}

router.get("/me", async (req, res, next) => {
  try {
    res.json(describe(await currentUser(req)));
  } catch (err) {
    next(err);
  }
});

router.post("/link", async (req, res, next) => {
  try {
    const bot = telegram.status();
    if (!bot.configured || !bot.username) return res.status(503).json({ error: "bot_not_ready" });
    const code = crypto.randomBytes(18).toString("base64url");
    const expiresAt = new Date(Date.now() + LINK_TTL_MS);
    await prisma.telegramLink.upsert({
      where: { userId: req.user.id },
      create: { userId: req.user.id, linkCodeHash: hashCode(code), linkCodeExpiresAt: expiresAt },
      update: { linkCodeHash: hashCode(code), linkCodeExpiresAt: expiresAt },
    });
    res.json({ url: `https://t.me/${bot.username}?start=${code}`, expiresAt });
  } catch (err) {
    next(err);
  }
});

router.patch("/me/prefs", async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const allowed = applicableKinds(user);
    const body = req.body || {};
    const prefs = { ...(user.telegram?.prefs || {}) };
    for (const [key, value] of Object.entries(body)) {
      if (!allowed.includes(key) || typeof value !== "boolean") throw badRequest(`invalid ${key}`);
      prefs[key] = value;
    }
    await prisma.telegramLink.upsert({ where: { userId: user.id }, create: { userId: user.id, prefs }, update: { prefs } });
    res.json(describe(await currentUser(req)));
  } catch (err) {
    next(err);
  }
});

router.post("/me/test", async (req, res, next) => {
  try {
    const ok = await notifyUser(req.user.id, null, "✅ Sinov xabari. Ledger xabarlari shu yerga keladi.");
    if (!ok) return res.status(409).json({ error: "not_connected" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/me", async (req, res, next) => {
  try {
    const link = await prisma.telegramLink.findUnique({ where: { userId: req.user.id } });
    if (link?.chatId) {
      await prisma.telegramLink.update({ where: { id: link.id }, data: { chatId: null, linkCodeHash: null } });
      api
        .sendMessage(link.chatId, "Bot Ledger hisobingizdan uzildi.", { reply_markup: { remove_keyboard: true } })
        .catch(() => {});
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Who has connected — to help everyone get set up.
router.get("/overview", requireRole(...MANAGER_ROLES), async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: { active: true, role: { not: "DEVELOPER" } },
      include: { employee: { include: { position: { select: { name: true } } } }, telegram: true },
    });
    const people = users
      .filter((u) => u.role !== "EMPLOYEE" || u.employee?.active)
      .map((u) => ({
        userId: u.id,
        name: u.employee?.name || u.name || u.username,
        role: u.role,
        position: u.employee?.position?.name ?? null,
        connected: Boolean(u.telegram?.chatId),
        telegramName: u.telegram?.chatId ? u.telegram.telegramName : null,
      }))
      .sort((a, b) => Number(a.connected) - Number(b.connected) || a.name.localeCompare(b.name));
    res.json({ bot: telegram.status(), people });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
