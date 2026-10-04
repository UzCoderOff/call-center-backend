const prisma = require("../lib/prisma");
const env = require("../config/env");
const push = require("./push");

// The Ledger app's own notifications (app 3.0+). Each one is a Notice row;
// Google push carries only its id ({ t: "notice", n: id }) and the app
// fetches the text with its device token (GET /api/device/notices/:id), so
// nothing about clients goes through Google.
//
// Everything the staff bot sends on Telegram comes here too
// (services/telegram/notify.js), and things only the app gets (chat,
// services/chat.js).

const KEEP_DAYS = 45;
// Still worth showing if the phone was off for a while.
const TTL_SEC = 24 * 60 * 60;

const configured = () => push.configured();

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
  if (!configured()) return false;
  return (await prisma.device.count({ where: { userId, revokedAt: null, fcmToken: { not: null } } })) > 0;
}

// { title, body?, link?, phone?, tag?, kind? } -> the person's phones.
// Whether at least one phone took it.
async function notifyApp(userId, notice) {
  if (!configured()) return false;
  const devices = await appDevices(userId);
  if (devices.length === 0) return false;
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
  let sent = false;
  for (const device of devices) {
    if ((await push.sendToDevice(device, { t: "notice", n: row.id }, { ttlSec: TTL_SEC })) === "sent") sent = true;
  }
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

async function cleanup() {
  await prisma.notice.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000) } } });
}

module.exports = { configured, notifyApp, hasApp, fromTelegram, publicNotice, cleanLink, cleanup };
