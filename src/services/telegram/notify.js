const prisma = require("../../lib/prisma");
const env = require("../../config/env");
const api = require("./api");
const { wants } = require("./prefs");

// Sending a notification to a person: only if the bot is set up, they have
// connected their Telegram, their account is active, and they haven't
// switched that kind off.

const USER_CONTEXT = { employee: true, calendar: true, telegram: true };

const enabled = () => Boolean(env.telegram.token);

function reachable(user) {
  if (!user?.active || !user.telegram?.chatId) return false;
  if (user.role === "EMPLOYEE" && user.employee && !user.employee.active) return false;
  return true;
}

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
async function notifyUser(userOrId, kind, text, extra) {
  if (!enabled()) return false;
  const user =
    typeof userOrId === "object" && userOrId.telegram !== undefined
      ? userOrId
      : await prisma.user.findUnique({ where: { id: typeof userOrId === "object" ? userOrId.id : userOrId }, include: USER_CONTEXT });
  if (!reachable(user)) return false;
  if (kind && !wants(user, kind)) return false;
  return sendTo(user, text, extra);
}

// Everyone with Telegram connected, with what notify needs to know.
function linkedUsers(where = {}) {
  return prisma.user.findMany({
    where: { active: true, telegram: { chatId: { not: null } }, ...where },
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

module.exports = { notifyUser, linkedUsers, once, enabled, reachable, disconnect, USER_CONTEXT };
