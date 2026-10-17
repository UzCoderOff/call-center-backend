const express = require("express");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const prisma = require("../lib/prisma");
const env = require("../config/env");
const { requireAuth, isManager } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { canAccessClient, requireClientAccess, restricted } = require("../lib/clientAccess");
const { phoneKey } = require("../lib/phone");
const { getSetting, setSetting } = require("../lib/settings");
const api = require("../services/telegram/api");
const inbox = require("../services/tgInbox");
const reviews = require("../services/tgReview");
const { claudeFeatureOn } = require("../services/ai/settings");
const { firmDayRange, firmNow } = require("../lib/firmTime");

// Clients' Telegram chats with the firm's account (services/tgInbox.js).
//
//   GET    /api/tg-inbox                  ?q=&hidden=1 — the chats, newest first
//   GET    /api/tg-inbox/status           the connected account, who answers, counts
//   PUT    /api/tg-inbox/settings         { operatorIds } (managers)
//   GET    /api/tg-inbox/client/:clientId the chats linked to a client (their page)
//   GET    /api/tg-inbox/:id              ?before=<messageId> — one chat, its messages
//   PATCH  /api/tg-inbox/:id              { clientId? | phone?, hidden? } (managers, call center)
//   GET    /api/tg-inbox/:id/phone-owner  ?phone= — whose number it is (to link a client
//                                         in work the operator can't open: by number)
//   GET    /api/tg-inbox/files/:messageId a photo, voice message or file (from Telegram)
//   GET    /api/tg-inbox/reviews          ?employeeId=&month= — the AI's reviews (beta) of
//                                         someone's chats (Natijalar): managers, or their own
//   POST   /api/tg-inbox/:id/review       the AI reviews it now (managers)

const router = express.Router();
router.use(requireAuth);
// Whether they answer the firm's Telegram (services/tgInbox.js reads it).
router.use(async (req, res, next) => {
  try {
    req.user.tgAnswerer = await inbox.isAnswerer(req.user);
    next();
  } catch (err) {
    next(err);
  }
});

const notFound = () => Object.assign(new Error("not_found"), { status: 404 });
const forbidden = () => Object.assign(new Error("forbidden"), { status: 403 });
const requireInbox = (user) => {
  if (!inbox.seesInbox(user)) throw forbidden();
};

// A chat this person may open (services/tgInbox.js chatScope).
async function chatFor(user, id) {
  const chat = await prisma.tgChat.findUnique({ where: { id }, include: { client: inbox.CLIENT_REF } });
  if (!chat || !(await inbox.canSeeChat(user, chat.id))) throw notFound();
  return chat;
}

const requireHandles = (user) => {
  if (!inbox.handlesNew(user)) throw forbidden();
};

// The one client with this number (all clients, not only theirs).
async function clientsByPhone(phone) {
  const key = phoneKey(phone);
  if (!key) return [];
  const rows = await prisma.clientPhone.findMany({ where: { phoneKey: key }, select: { clientId: true } });
  return [...new Set(rows.map((r) => r.clientId))];
}

const PAGE = 100;
const MESSAGES = 300;

router.get("/", async (req, res, next) => {
  try {
    requireInbox(req.user);
    const q = String(req.query.q ?? "").trim().replace(/^@/, "");
    const where = { hidden: req.query.hidden === "1" && isManager(req.user), lastMessageAt: { not: null }, AND: [inbox.chatScope(req.user)] };
    if (q) {
      const digits = q.replace(/\D/g, "");
      where.OR = [{ firstName: { contains: q } }, { lastName: { contains: q } }, { username: { contains: q } }, ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : []), { client: { name: { contains: q } } }];
    }
    const rows = await prisma.tgChat.findMany({
      where,
      orderBy: { lastMessageAt: "desc" },
      take: PAGE,
      include: { client: inbox.CLIENT_REF, messages: inbox.LAST_MESSAGE },
    });
    const waiting = await prisma.tgChat.count({ where: { hidden: false, waitingSince: { not: null }, AND: [inbox.chatScope(req.user)] } });
    res.json({ chats: rows.map(inbox.chatLine), waiting });
  } catch (err) {
    next(err);
  }
});

router.get("/status", async (req, res, next) => {
  try {
    requireInbox(req.user);
    const connection = await getSetting(inbox.CONNECTION_KEY, {});
    const { operatorIds } = await getSetting(inbox.SETTINGS_KEY, inbox.DEFAULTS);
    const operators = await prisma.user.findMany({ where: { id: { in: operatorIds } }, select: { id: true, name: true, username: true, employee: { select: { name: true } } } });
    const [chats, waiting, messages] = await Promise.all([
      prisma.tgChat.count({ where: { hidden: false } }),
      prisma.tgChat.count({ where: { hidden: false, waitingSince: { not: null } } }),
      prisma.tgMessage.count(),
    ]);
    const r = await reviews.reviewSettings();
    res.json({
      bot: require("../services/telegram").status(),
      connection: connection.id ? connection : null,
      operators: operators.map((u) => ({ id: u.id, name: u.employee?.name || u.name || u.username })),
      counts: { chats, waiting, messages },
      review: { on: await claudeFeatureOn("tgReview"), model: r.reviewModel, models: reviews.MODELS, rules: r.rules, customRules: r.customRules, defaultRules: reviews.DEFAULT_RULES },
    });
  } catch (err) {
    next(err);
  }
});

router.put("/settings", async (req, res, next) => {
  try {
    if (!isManager(req.user)) throw forbidden();
    const b = req.body || {};
    const current = await getSetting(inbox.SETTINGS_KEY, inbox.DEFAULTS);
    const saved = { ...current };
    if (b.operatorIds !== undefined) {
      if (!Array.isArray(b.operatorIds) || b.operatorIds.length > 10) throw badRequest("invalid operatorIds");
      const wanted = [...new Set(b.operatorIds.map((v) => parseId(v, "operatorIds")))];
      const found = await prisma.user.count({ where: { id: { in: wanted }, active: true } });
      if (found !== wanted.length) throw badRequest("unknown operator");
      saved.operatorIds = wanted;
    }
    // The firm's rules the AI judges by ("" or the default text: the default).
    if (b.rules !== undefined) {
      if (b.rules !== null && typeof b.rules !== "string") throw badRequest("invalid rules");
      const text = String(b.rules ?? "").replace(/\r\n/g, "\n").trim().slice(0, 4000);
      saved.rules = text === reviews.DEFAULT_RULES ? "" : text;
    }
    // Another Telegram account may connect (the firm changed its account).
    if (b.resetConnection === true) await setSetting(inbox.CONNECTION_KEY, {}, req.user.id);
    if (b.reviewModel !== undefined) {
      if (!reviews.MODELS.includes(b.reviewModel)) throw badRequest("invalid reviewModel");
      saved.reviewModel = b.reviewModel;
    }
    await setSetting(inbox.SETTINGS_KEY, saved, req.user.id);
    res.json({ operatorIds: saved.operatorIds || [], rules: saved.rules || "", reviewModel: saved.reviewModel || reviews.MODELS[0] });
  } catch (err) {
    next(err);
  }
});

// Someone's reviewed chats in a month (Natijalar → their page): what the AI
// said, newest first, and the counts.
router.get("/reviews", async (req, res, next) => {
  try {
    const employeeId = parseId(req.query.employeeId, "employeeId");
    const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { userId: true } });
    if (!employee) throw notFound();
    if (!isManager(req.user) && req.user.employee?.id !== employeeId) throw notFound();
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? req.query.month : firmNow().date.slice(0, 7);
    const [y, m] = month.split("-").map(Number);
    const nextMonth = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`;
    const from = new Date(firmDayRange(`${month}-01`).from);
    const to = new Date(firmDayRange(nextMonth).from);
    if (!employee.userId) return res.json({ month, counts: {}, averageScore: null, reviews: [] });
    // The latest look at each chat that month (a chat looked at twice: once).
    const rows = await prisma.tgReview.findMany({
      where: { operatorId: employee.userId, relevant: true, createdAt: { gte: from, lt: to } },
      orderBy: { createdAt: "desc" },
      include: { chat: { select: { id: true, firstName: true, lastName: true, username: true, client: { select: { id: true, name: true } } } }, operator: { select: { name: true, username: true, employee: { select: { name: true } } } } },
    });
    const seen = new Set();
    const latest = rows.filter((r) => !seen.has(r.chatId) && seen.add(r.chatId));
    const counts = {};
    for (const r of latest) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
    const scored = latest.filter((r) => r.score > 0);
    res.json({
      month,
      counts,
      averageScore: scored.length ? Math.round((scored.reduce((s, r) => s + r.score, 0) / scored.length) * 10) / 10 : null,
      reviews: latest.slice(0, 50).map((r) => ({ ...reviews.reviewLine(r), chat: { id: r.chat.id, name: r.chat.client?.name || inbox.displayName(r.chat), clientId: r.chat.client?.id ?? null } })),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/client/:clientId", async (req, res, next) => {
  try {
    const clientId = parseId(req.params.clientId, "clientId");
    await requireClientAccess(req.user, clientId);
    const rows = await prisma.tgChat.findMany({
      where: { clientId, AND: [inbox.chatScope(req.user)] },
      orderBy: { lastMessageAt: "desc" },
      include: { client: inbox.CLIENT_REF, messages: inbox.LAST_MESSAGE, _count: { select: { messages: true } } },
    });
    res.json(rows.map((c) => ({ ...inbox.chatLine(c), messageCount: c._count.messages })));
  } catch (err) {
    next(err);
  }
});

const ANSWERED_BY = { select: { name: true, username: true, employee: { select: { name: true } } } };

router.get("/files/:messageId", async (req, res, next) => {
  try {
    const message = await prisma.tgMessage.findUnique({ where: { id: parseId(req.params.messageId, "messageId") } });
    if (!message || !message.fileId || message.deletedAt) throw notFound();
    await chatFor(req.user, message.chatId);
    // Telegram keeps the file; the bot fetches it (up to 20 MB) and passes it on.
    let file;
    try {
      file = await api.call("getFile", { file_id: message.fileId });
    } catch (err) {
      if (err.code === 400) return res.status(410).json({ error: "file_unavailable" });
      throw err;
    }
    if (!file?.file_path) return res.status(410).json({ error: "file_unavailable" });
    const upstream = await fetch(`${env.telegram.apiUrl}/file/bot${env.telegram.token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
    if (!upstream.ok || !upstream.body) return res.status(502).json({ error: "telegram_unavailable" });
    // Only what we know shows in the page (a photo, a voice or video message);
    // anything a stranger sent as a file is downloaded, never opened here.
    const SHOWN = { voice: "audio/ogg", photo: "image/jpeg", video_note: "video/mp4" };
    const shown = SHOWN[message.kind] && req.query.download !== "1";
    res.setHeader("Content-Type", SHOWN[message.kind] || "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    const size = upstream.headers.get("content-length");
    if (size) res.setHeader("Content-Length", size);
    res.setHeader("Cache-Control", "private, max-age=3600");
    const name = message.fileName || file.file_path.split("/").pop() || "file";
    res.setHeader("Content-Disposition", `${shown ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`);
    await pipeline(Readable.fromWeb(upstream.body), res).catch(() => res.destroy());
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const chat = await chatFor(req.user, parseId(req.params.id));
    const before = req.query.before ? parseId(req.query.before, "before") : null;
    const rows = await prisma.tgMessage.findMany({
      where: { chatId: chat.id, ...(before ? { id: { lt: before } } : {}) },
      orderBy: [{ sentAt: "desc" }, { id: "desc" }],
      take: MESSAGES + 1,
      include: { answeredBy: ANSWERED_BY },
    });
    const hasOlder = rows.length > MESSAGES;
    const latest = await prisma.tgReview.findFirst({ where: { chatId: chat.id }, orderBy: { id: "desc" }, include: { operator: ANSWERED_BY } });
    // A judgement of someone's work: for managers, and for the one it's about.
    // The AI's feedback: managers, and everyone who answers the firm's
    // Telegram — one shared account, one shared lesson (2026-10-17).
    const review = latest && (isManager(req.user) || req.user.tgAnswerer || latest.operatorId === req.user.id) ? latest : null;
    res.json({
      chat: { ...inbox.chatLine(chat), canManage: inbox.handlesNew(req.user), canReview: isManager(req.user) },
      messages: rows.slice(0, MESSAGES).reverse().map(inbox.messageLine),
      hasOlder,
      review: reviews.reviewLine(review),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/review", async (req, res, next) => {
  try {
    if (!isManager(req.user)) throw forbidden();
    const chat = await chatFor(req.user, parseId(req.params.id));
    let review;
    try {
      review = await reviews.reviewChat(chat.id);
    } catch (err) {
      const claude = require("../services/ai/claude");
      return res.status(409).json({ error: "ai_failed", message: claude.explain(err) });
    }
    if (!review) return res.status(409).json({ error: "nothing_to_review" });
    const full = await prisma.tgReview.findUnique({ where: { id: review.id }, include: { operator: ANSWERED_BY } });
    res.json(reviews.reviewLine(full));
  } catch (err) {
    next(err);
  }
});

router.get("/:id/phone-owner", async (req, res, next) => {
  try {
    requireHandles(req.user);
    await chatFor(req.user, parseId(req.params.id));
    const ids = await clientsByPhone(req.query.phone);
    if (ids.length === 0) return res.json({ found: false });
    if (ids.length > 1) return res.json({ found: true, several: true });
    const client = await prisma.client.findUnique({
      where: { id: ids[0] },
      select: { id: true, name: true, cases: { select: { status: true, operator: { select: { name: true } }, coordinator: { select: { name: true } } } } },
    });
    if (await canAccessClient(req.user, client.id)) return res.json({ found: true, client: { id: client.id, name: client.name } });
    // Someone else's client: who looks after them, not who they are.
    const r = restricted(client);
    res.json({ found: true, restricted: { coordinator: r.coordinator, operator: r.operator, inWork: client.cases.some((k) => ["contract", "done"].includes(k.status)) } });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    requireHandles(req.user);
    const chat = await chatFor(req.user, parseId(req.params.id));
    const b = req.body || {};
    const data = {};
    // By number: the client behind it, even one this person can't open (a
    // client in work) — the chat then goes to their coordinator.
    if (b.phone !== undefined) {
      const ids = await clientsByPhone(b.phone);
      if (ids.length !== 1) throw Object.assign(new Error(ids.length ? "several_clients" : "no_client"), { status: 409 });
      data.clientId = ids[0];
      data.autoLink = false;
      if (!chat.phone) Object.assign(data, { phone: String(b.phone).trim().slice(0, 40), phoneKey: phoneKey(b.phone) });
    }
    if (b.clientId !== undefined) {
      if (b.clientId === null) data.clientId = null;
      else {
        const clientId = parseId(b.clientId, "clientId");
        await requireClientAccess(req.user, clientId);
        data.clientId = clientId;
      }
      data.autoLink = false;
    }
    if (b.hidden !== undefined) {
      data.hidden = Boolean(b.hidden);
      data.aiHidden = false;
    }
    if (!Object.keys(data).length) throw badRequest("nothing to change");
    const updated = await prisma.tgChat.update({ where: { id: chat.id }, data, include: { client: inbox.CLIENT_REF, messages: inbox.LAST_MESSAGE } });
    // Linked to a client in work: theirs now — the operator may no longer see it.
    const stillSees = await inbox.canSeeChat(req.user, chat.id);
    res.json({ ...inbox.chatLine(updated), handedOver: !stillSees });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
