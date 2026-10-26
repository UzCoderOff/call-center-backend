const prisma = require("../lib/prisma");
const { getSetting, setSetting } = require("../lib/settings");
const inbox = require("./tgInbox");

// The firm's Instagram in the same inbox as its Telegram (2026-10-26).
//
// The firm connected its Instagram (a business account) to treg (treg.to),
// which holds the Instagram login and renews it; Ledger holds only a treg
// agent token limited to that one tool (TREG_TOKEN) and asks through it.
// Instagram can't call Ledger (that needs the firm's own Meta app), so
// Ledger asks every minute: the chats changed lately and their latest
// messages. Only messages from the first look on are kept — never older ones.
//
// Staff reply in the Instagram app; the AI may reply to new people
// (services/aiReply) — Instagram allows it within 24 hours of the person's
// last message.

const TREG = (process.env.TREG_URL || "https://treg.to").replace(/\/+$/, "");
// What Ledger remembers: { since, ownId, username, lastOkAt, lastError, lastErrorAt }.
const STATE_KEY = "igInbox";
const FIELDS = "id,updated_time,messages.limit(20){id,created_time,from,to,message,attachments}";

const configured = () => Boolean(process.env.TREG_TOKEN);

class InstagramError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// One call to Instagram's API through treg (the firm's login is added there).
async function call(path, { method = "GET", json } = {}) {
  if (!configured()) throw new InstagramError("instagram_not_configured", 409);
  const res = await fetch(`${TREG}/call/instagram/${path}`, {
    method,
    headers: { "X-Treg-Token": process.env.TREG_TOKEN, ...(json ? { "Content-Type": "application/json" } : {}) },
    body: json ? JSON.stringify(json) : undefined,
    signal: AbortSignal.timeout(30 * 1000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new InstagramError(body.error?.message || body.message || `HTTP ${res.status}`, res.status, body.error?.code ?? null);
  return body;
}

// An Instagram message -> what we keep of it (no files: their links expire).
function parse(m) {
  const text = m.message ? String(m.message).slice(0, 4096) : null;
  const a = m.attachments?.data?.[0];
  if (!a) return { kind: text ? "text" : "other", text };
  if (a.image_data) return { kind: "photo", text };
  if (a.video_data) return { kind: "video", text };
  if (a.audio_data) return { kind: "voice", text };
  if (a.file_url) return { kind: "document", text, fileName: a.name ? String(a.name).slice(0, 200) : null };
  return { kind: "other", text };
}

async function chatFor(igsid, username) {
  return prisma.tgChat.upsert({
    where: { platform_tgUserId: { platform: "instagram", tgUserId: igsid } },
    create: { platform: "instagram", tgUserId: igsid, username: username || null },
    update: username ? { username } : {},
  });
}

// The firm's own reply that Ledger's AI sent: Instagram may show it with an
// id of its own — the same words, sent within a few minutes.
async function isAiEcho(chatId, m, at) {
  const text = m.message ? String(m.message) : null;
  if (!text) return false;
  const near = 5 * 60 * 1000;
  const twin = await prisma.tgMessage.findFirst({
    where: { chatId, ai: true, text, sentAt: { gte: new Date(at.getTime() - near), lte: new Date(at.getTime() + near) } },
    select: { id: true, extId: true },
  });
  if (!twin) return false;
  if (twin.extId !== m.id) await prisma.tgMessage.update({ where: { id: twin.id }, data: { extId: m.id } }).catch(() => {});
  return true;
}

// Every minute (services/scheduler.js). -> how many new messages.
async function poll(now = new Date()) {
  if (!configured()) return 0;
  const state = await getSetting(STATE_KEY, {});
  try {
    let { ownId, username } = state;
    if (!ownId) {
      const me = await call("me?fields=user_id,username");
      ownId = String(me.user_id || me.id);
      username = me.username || null;
    }
    // The first look: from now on (kept at once, so a failed look doesn't move it).
    const since = state.since ? new Date(state.since) : now;
    if (!state.since) await setSetting(STATE_KEY, { ...state, since: since.toISOString() }, null);
    const list = await call(`me/conversations?platform=instagram&limit=20&fields=${encodeURIComponent(FIELDS)}`);
    let added = 0;
    for (const conv of list.data || []) {
      if (new Date(conv.updated_time) < since) continue;
      // Newest first from Instagram: kept oldest first.
      const messages = [...(conv.messages?.data || [])].reverse();
      for (const m of messages) {
        const at = new Date(m.created_time);
        if (!(at >= since) || !m.id) continue;
        const out = String(m.from?.id ?? "") === ownId;
        const them = out ? m.to?.data?.[0] : m.from;
        if (!them?.id) continue;
        const chat = await chatFor(String(them.id), out ? them.username : m.from?.username);
        if (await prisma.tgMessage.count({ where: { chatId: chat.id, extId: m.id } })) continue;
        if (out && (await isAiEcho(chat.id, m, at))) continue;
        await inbox.record(chat, { ...parse(m), extId: m.id, out, sentAt: at });
        added += 1;
      }
    }
    await setSetting(STATE_KEY, { ...state, ownId, username, since: since.toISOString(), lastOkAt: now.toISOString(), lastError: null }, null);
    return added;
  } catch (err) {
    // Shown in Sozlamalar; asked again next minute.
    await setSetting(STATE_KEY, { ...state, lastError: err.message, lastErrorAt: now.toISOString() }, null).catch(() => {});
    throw err;
  }
}

// Send a text to someone who wrote to the firm's Instagram. -> { extId }
async function send(chat, text) {
  const { ownId } = await getSetting(STATE_KEY, {});
  const r = await call(`${ownId || "me"}/messages`, { method: "POST", json: { recipient: { id: chat.tgUserId }, message: { text } } });
  return { extId: r.message_id || null };
}

async function status() {
  const s = await getSetting(STATE_KEY, {});
  return { configured: configured(), username: s.username || null, since: s.since || null, lastOkAt: s.lastOkAt || null, lastError: s.lastError || null, lastErrorAt: s.lastErrorAt || null };
}

module.exports = { configured, call, parse, poll, send, status, InstagramError, STATE_KEY };
