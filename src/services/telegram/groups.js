const prisma = require("../../lib/prisma");
const api = require("./api");
const { getSetting, setSetting } = require("../../lib/settings");
const { reachable, USER_CONTEXT, once } = require("./notify");

// The firm's Telegram groups for Ledger's release notes — "Ledger yangilandi"
// (the user's ask, 2026-10-24: most staff never connected the bot privately,
// so the notes go to the staff group too). Groups get ONLY the release notes:
// nothing about clients, calls or money.
//
// Connecting: a developer or the boss, connected to the bot privately, adds
// the bot to the group — that's all. Added by anyone else, the bot says who
// can and stays out. Removing the bot from the group (or the group going
// away) stops it. Setting "tgGroups": [{ chatId, title, addedById, addedAt }].

const SETTING = "tgGroups";
const CONNECTS = new Set(["DEVELOPER", "BOSS"]);
const isGroup = (chat) => chat?.type === "group" || chat?.type === "supergroup";

async function groups() {
  const value = await getSetting(SETTING, []);
  return Array.isArray(value) ? value : [];
}

async function saveGroups(list, userId = null) {
  await setSetting(SETTING, list, userId);
}

// Who added the bot, as a Ledger user who may connect a group (null if not).
async function connector(from) {
  if (!from?.id) return null;
  // A private chat's id is the person's Telegram id.
  const link = await prisma.telegramLink.findUnique({ where: { chatId: String(from.id) }, include: { user: { include: USER_CONTEXT } } });
  const user = link?.user;
  return user && reachable(user) && CONNECTS.has(user.role) ? user : null;
}

// The bot was added to, or removed from, a chat (my_chat_member).
async function onMemberUpdate(update) {
  const chat = update?.chat;
  if (!isGroup(chat)) return;
  const status = update.new_chat_member?.status;
  const chatId = String(chat.id);
  const list = await groups();
  if (status === "left" || status === "kicked") {
    if (list.some((g) => g.chatId === chatId)) await saveGroups(list.filter((g) => g.chatId !== chatId));
    return;
  }
  if (status !== "member" && status !== "administrator") return;
  if (list.some((g) => g.chatId === chatId)) return;
  const user = await connector(update.from);
  if (!user) {
    await api.sendMessage(chatId, "Ledger bu guruhga yangiliklarni faqat dasturchi yoki rahbar qoʻshganda yuboradi (Ledger botiga ulangan boʻlishi kerak).").catch(() => {});
    return;
  }
  await saveGroups([...list, { chatId, title: String(chat.title || "").slice(0, 120), addedById: user.id, addedAt: new Date().toISOString() }], user.id);
  console.log(`[telegram] group "${chat.title}" connected for Ledger's news`);
  await api.sendMessage(chatId, "✅ Ledger shu guruhga ulandi: Ledger yangilanganda nima oʻzgargani shu yerga yoziladi.").catch(() => {});
}

// A group that became a supergroup gets a new id.
async function onMigrated(msg) {
  if (!msg?.migrate_to_chat_id) return;
  const from = String(msg.chat.id);
  const list = await groups();
  if (!list.some((g) => g.chatId === from)) return;
  await saveGroups(list.map((g) => (g.chatId === from ? { ...g, chatId: String(msg.migrate_to_chat_id) } : g)));
}

// Posts `text` to every connected group once for `key` (a restart or an
// overlapping check never posts it twice). -> how many got it.
async function postToGroups(key, text) {
  let sent = 0;
  for (const g of await groups()) {
    const ok = await once(`${key}:group:${g.chatId}`, async () => {
      try {
        await api.sendMessage(g.chatId, text);
        return true;
      } catch (err) {
        if (api.chatIsGone(err)) await saveGroups((await groups()).filter((x) => x.chatId !== g.chatId));
        else console.error(`[telegram] message to group ${g.chatId} failed:`, err.message);
        return false;
      }
    });
    if (ok) sent += 1;
  }
  return sent;
}

module.exports = { groups, onMemberUpdate, onMigrated, postToGroups, isGroup, SETTING };
