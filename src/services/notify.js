const prisma = require("../lib/prisma");
const env = require("../config/env");
const push = require("./push");
const web = require("./push/web");

// Ledger's own notifications: on phones with the Ledger app (3.0+) and in
// browsers where someone allowed them (the portal, services/push/web.js).
// Each one is a Notice row. To the app, Google push carries only its id
// ({ t: "notice", n: id }) and the app fetches the text with its device
// token (GET /api/device/notices/:id), so nothing about clients goes
// through Google; to a browser, the text goes encrypted for that browser.
//
// Everything the staff bot sends on Telegram comes here too
// (services/telegram/notify.js), and things only the app and browsers get
// (chat, services/chat.js).
//
// Every notification is kept (KEEP_DAYS), whether or not it reached a
// phone or browser: the bell on the home page lists them
// (routes/notices.js) — all but chat messages, which the chat has.

const KEEP_DAYS = 45;
// Still worth showing if the phone was off for a while.
const TTL_SEC = 24 * 60 * 60;

const configured = () => push.configured() || web.configured();

const clip = (value, max) => {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
};

// A portal path ("/tasks"), never an address elsewhere.
function cleanLink(link) {
  if (typeof link !== "string" || !link.startsWith("/") || link.startsWith("//")) return null;
  return link.slice(0, 300);
}

// Phones that can get it: signed in, with a push address (Ledger 3.0+).
function appDevices(userId) {
  return prisma.device.findMany({ where: { userId, revokedAt: null, fcmToken: { not: null } } });
}

async function hasApp(userId) {
  if (push.configured() && (await prisma.device.count({ where: { userId, revokedAt: null, fcmToken: { not: null } } })) > 0) return true;
  return web.hasBrowser(userId);
}

// { title, body?, link?, phone?, tag?, kind? } -> the bell, and the
// person's phones and browsers. Whether at least one of those took it.
async function notifyPush(userId, notice) {
  const row = await prisma.notice.create({
    data: {
      userId,
      kind: notice.kind ?? null,
      title: clip(notice.title, 200) || "Ledger",
      body: clip(notice.body, 1500),
      link: cleanLink(notice.link),
      phone: clip(notice.phone, 40),
      tag: clip(notice.tag, 60),
    },
  });
  if (!IN_BELL_HIDDEN.has(row.kind)) require("./live").bump([userId]);
  if (!configured()) return false;
  const devices = push.configured() ? await appDevices(userId) : [];
  const browsers = await web.hasBrowser(userId);
  let sent = false;
  for (const device of devices) {
    if ((await push.sendToDevice(device, { t: "notice", n: row.id }, { ttlSec: TTL_SEC })) === "sent") sent = true;
  }
  if (browsers && (await web.sendToUser(userId, { id: row.id, title: row.title, body: row.body, link: row.link, tag: row.tag || `notice:${row.id}` }))) sent = true;
  return sent;
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#039;": "'" };
const unescapeHtml = (text) => text.replace(/&(amp|lt|gt|quot|#0?39);/g, (m) => ENTITIES[m] ?? m);

// The portal path of a link to the portal, or null.
function portalPath(href) {
  const base = env.portalUrl;
  if (!base || !href.startsWith(base)) return null;
  return href.slice(base.length) || "/";
}

// A Telegram message (HTML) as an app notification: the first line is the
// title, the rest the text; a link to the portal is where a tap goes (the
// line that's only that link isn't shown).
function fromTelegram(html) {
  let link = null;
  const lines = [];
  for (const raw of String(html ?? "").split("\n")) {
    const anchor = raw.match(/<a href="([^"]*)"/);
    if (anchor) {
      link = link || portalPath(unescapeHtml(anchor[1]));
      if (raw.replace(/<a [^>]*>.*?<\/a>/g, "").trim() === "") continue;
    }
    const plain = unescapeHtml(raw.replace(/<[^>]+>/g, "")).trim();
    if (plain) lines.push(plain);
  }
  return { title: lines[0] || "Ledger", body: lines.slice(1).join("\n") || null, link };
}

// What the app shows for one of its notices.
function publicNotice(n) {
  return { id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, phone: n.phone, tag: n.tag, createdAt: n.createdAt };
}

// The bell: newest first, `limit` at a time, older than notice `before`.
const IN_BELL_HIDDEN = new Set(["chat"]);
const bellWhere = (userId) => ({ userId, OR: [{ kind: null }, { kind: { notIn: [...IN_BELL_HIDDEN] } }] });

async function bell(userId, { before, limit = 30 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const where = bellWhere(userId);
  if (Number.isInteger(before)) where.id = { lt: before };
  const rows = await prisma.notice.findMany({ where, orderBy: { id: "desc" }, take: take + 1 });
  const unread = await prisma.notice.count({ where: { ...bellWhere(userId), readAt: null } });
  return { items: rows.slice(0, take).map((n) => ({ ...publicNotice(n), readAt: n.readAt })), more: rows.length > take, unread };
}

const bellUnread = (userId) => prisma.notice.count({ where: { ...bellWhere(userId), readAt: null } });

// Seen: these ids, or everything up to notice `upTo`.
async function markSeen(userId, { ids, upTo } = {}) {
  const where = { userId, readAt: null };
  if (Array.isArray(ids)) where.id = { in: ids.filter(Number.isInteger).slice(0, 200) };
  else if (Number.isInteger(upTo)) where.id = { lte: upTo };
  else return 0;
  const { count } = await prisma.notice.updateMany({ where, data: { readAt: new Date() } });
  // The bell's number on the person's other screens.
  if (count) require("./live").bump([userId]);
  return count;
}

async function cleanup() {
  await prisma.notice.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000) } } });
}

module.exports = { configured, notifyPush, hasApp, fromTelegram, publicNotice, cleanLink, cleanup, bell, bellUnread, markSeen, IN_BELL_HIDDEN };
