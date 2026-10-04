const prisma = require("../../lib/prisma");
const env = require("../../config/env");
const api = require("./api");
const { wants } = require("./prefs");
const app = require("../notify");

// Sending a notification to a person: on Telegram if the bot is set up and
// they've connected it, and in the Ledger app and browsers (services/notify.js)
// — only while their account is active and they haven't switched that kind
// off.

const USER_CONTEXT = { employee: true, calendar: true, telegram: true };

const enabled = () => Boolean(env.telegram.token);
// Notifications go somewhere at all: the bot, the app, or both.
const anyChannel = () => enabled() || app.configured();

function active(user) {
  if (!user?.active) return false;
  if (user.role === "EMPLOYEE" && user.employee && !user.employee.active) return false;
  return true;
}

// Telegram connected (and the account active).
const reachable = (user) => active(user) && Boolean(user.telegram?.chatId);

// Stop sending to a chat that blocked the bot or no longer exists.
async function disconnect(linkId) {
  await prisma.telegramLink.update({ where: { id: linkId }, data: { chatId: null } }).catch(() => {});
}

async function sendTo(user, text, extra) {
  try {
    await api.sendMessage(user.telegram.chatId, text, extra);
    return true;
  } catch (err) {
    if (api.chatIsGone(err)) await disconnect(user.telegram.id);
    else console.error(`[telegram] message to user ${user.id} failed:`, err.message);
    return false;
  }
}

// `kind` null: always sent (a reply the person asked for, a test message).
// `app: false`: Telegram only (e.g. the Telegram test message); `appExtra`:
// what only the app shows ({ kind, phone, tag }, services/notify.js).
async function notifyUser(userOrId, kind, text, extra, { app: toApp = true, appExtra = {} } = {}) {
  if (!anyChannel()) return false;
  const user =
    typeof userOrId === "object" && userOrId.telegram !== undefined
      ? userOrId
      : await prisma.user.findUnique({ where: { id: typeof userOrId === "object" ? userOrId.id : userOrId }, include: USER_CONTEXT });
  if (!active(user)) return false;
  if (kind && !wants(user, kind)) return false;
  let delivered = false;
  if (enabled() && user.telegram?.chatId) delivered = await sendTo(user, text, extra);
  if (toApp) {
    try {
      if (await app.notifyPush(user.id, { kind, ...app.fromTelegram(text), ...appExtra })) delivered = true;
    } catch (err) {
      console.error(`[notify] app notification to user ${user.id} failed:`, err.message);
    }
  }
  return delivered;
}

// Everyone notifications can reach — Telegram connected, the Ledger app
// with push, or a browser with notifications on — with what notify needs.
function linkedUsers(where = {}) {
  return prisma.user.findMany({
    where: {
      active: true,
      AND: [where, { OR: [{ telegram: { chatId: { not: null } } }, { devices: { some: { revokedAt: null, fcmToken: { not: null } } } }, { webPush: { some: {} } }] }],
    },
    include: USER_CONTEXT,
  });
}

// Runs `send` only if nothing was sent under `key` before — so a restart,
// or two checks overlapping, never sends the same notification twice. The
// key is claimed first: if sending then fails, it isn't retried (a missed
// notification is better than a repeated one).
async function once(key, send) {
  try {
    await prisma.telegramNotice.create({ data: { key } });
  } catch (err) {
    if (err.code === "P2002") return false;
    throw err;
  }
  return send();
}

module.exports = { notifyUser, linkedUsers, once, enabled, anyChannel, reachable, disconnect, USER_CONTEXT };
