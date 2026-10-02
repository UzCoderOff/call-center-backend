const crypto = require("crypto");
const prisma = require("../../lib/prisma");
const env = require("../../config/env");
const api = require("./api");
const f = require("./format");
const { KINDS, applicableKinds, effectivePrefs } = require("./prefs");
const { reachable, USER_CONTEXT } = require("./notify");
const { myDay, tomorrow } = require("./today");

// The bot's side of the conversation. It receives messages by long polling
// (getUpdates) — no public web address or certificate needed, and it works
// behind any firewall. Only ONE running server may poll a given bot token.
//
// Staff connect from the portal (Profile -> Telegram): the portal opens
// t.me/<bot>?start=<one-time code>, the person presses Start, and the code
// ties this chat to their account. The bot talks only in private chats and
// only to connected people, and shows each person what the portal shows
// them — nothing more.

const hashCode = (code) => crypto.createHash("sha256").update(code).digest("hex");

// Big buttons under the message box — easier than typing commands.
const BUTTONS = { today: "📅 Bugun", tomorrow: "🗓 Ertaga", settings: "⚙️ Sozlamalar", help: "❓ Yordam" };
const MENU = {
  keyboard: [[{ text: BUTTONS.today }, { text: BUTTONS.tomorrow }], [{ text: BUTTONS.settings }, { text: BUTTONS.help }]],
  resize_keyboard: true,
  is_persistent: true,
};

const state = { username: null, status: "off", error: null, startedAt: null };

function reply(chatId, text, extra) {
  return api.sendMessage(chatId, text, extra).catch((err) => console.error("[telegram] reply failed:", err.message));
}

function helpText(user) {
  const kinds = applicableKinds(user).map((key) => KINDS.find((k) => k.key === key));
  return [
    "<b>Ledger boti</b> — ishingiz boʻyicha xabarlar shu yerga keladi:",
    ...kinds.map((k) => `• ${k.label} — ${k.hint}`),
    "",
    `${BUTTONS.today} — bugungi reja`,
    `${BUTTONS.tomorrow} — ertangi uchrashuvlar`,
    `${BUTTONS.settings} — qaysi xabarlar kelishini tanlash`,
    "/uzish — botni hisobingizdan uzish",
    env.portalUrl ? `\n${f.portalLink("/", "Ledgerni ochish")}` : "",
  ].join("\n");
}

function settingsMarkup(user) {
  const prefs = effectivePrefs(user, user.telegram?.prefs);
  return {
    inline_keyboard: applicableKinds(user).map((key) => [
      { text: `${prefs[key] ? "✅" : "⬜️"} ${KINDS.find((k) => k.key === key).label}`, callback_data: `pref:${key}` },
    ]),
  };
}

async function userForChat(chatId) {
  const link = await prisma.telegramLink.findUnique({ where: { chatId: String(chatId) }, include: { user: { include: USER_CONTEXT } } });
  const user = link?.user;
  return user && reachable(user) ? user : null;
}

// /start <code>: connect this chat to the account that asked for the code.
async function connect(chatId, from, code) {
  const link = await prisma.telegramLink.findUnique({ where: { linkCodeHash: hashCode(code) }, include: { user: { include: USER_CONTEXT } } });
  if (!link || !link.linkCodeExpiresAt || link.linkCodeExpiresAt < new Date() || !link.user.active) {
    return reply(chatId, "Bu havola eskirgan. Portalda <b>Profil → Telegram → Ulash</b> tugmasini qayta bosing.");
  }
  const telegramName = from?.username ? `@${from.username}` : [from?.first_name, from?.last_name].filter(Boolean).join(" ") || null;
  await prisma.$transaction([
    // One Telegram, one account: a chat connected elsewhere before moves here.
    prisma.telegramLink.updateMany({ where: { chatId: String(chatId), NOT: { id: link.id } }, data: { chatId: null } }),
    prisma.telegramLink.update({
      where: { id: link.id },
      data: { chatId: String(chatId), telegramName: telegramName?.slice(0, 80) || null, linkedAt: new Date(), linkCodeHash: null, linkCodeExpiresAt: null },
    }),
  ]);
  const user = { ...link.user, telegram: { ...link, chatId: String(chatId) } };
  const first = f.personName(user).split(" ")[0];
  return reply(chatId, `✅ <b>Ulandi!</b> Salom, ${f.escapeHtml(first)}.\n\n${helpText(user)}`, { reply_markup: MENU });
}

async function disconnect(chatId, user) {
  await prisma.telegramLink.update({ where: { userId: user.id }, data: { chatId: null } });
  return reply(chatId, "Bot hisobingizdan uzildi. Qayta ulash uchun portalda <b>Profil → Telegram</b> ga kiring.", {
    reply_markup: { remove_keyboard: true },
  });
}

async function onMessage(msg) {
  if (msg.chat?.type !== "private" || typeof msg.text !== "string") return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  const start = text.match(/^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{16,64}))?$/);
  if (start?.[1]) return connect(chatId, msg.from, start[1]);

  const user = await userForChat(chatId);
  if (!user) {
    return reply(
      chatId,
      "Assalomu alaykum! Bu bot firma xodimlari uchun.\nUlash uchun portalda <b>Profil → Telegram → Ulash</b> tugmasini bosing." +
        (env.portalUrl ? `\n\n${f.portalLink("/profile", "Profilni ochish")}` : "")
    );
  }

  if (start || text === "/yordam" || text === "/help" || text === BUTTONS.help) return reply(chatId, helpText(user), { reply_markup: MENU });
  if (text === "/bugun" || text === BUTTONS.today) return reply(chatId, await myDay(user), { reply_markup: MENU });
  if (text === "/ertaga" || text === BUTTONS.tomorrow) return reply(chatId, await tomorrow(user), { reply_markup: MENU });
  if (text === "/sozlamalar" || text === BUTTONS.settings) {
    return reply(chatId, "Qaysi xabarlar kelsin? Bosib yoqing yoki oʻchiring:", { reply_markup: settingsMarkup(user) });
  }
  if (text === "/uzish") {
    return reply(chatId, "Botni hisobingizdan uzaymi? Xabarlar kelmay qoladi.", {
      reply_markup: { inline_keyboard: [[{ text: "Ha, uzish", callback_data: "unlink:yes" }, { text: "Yoʻq", callback_data: "unlink:no" }]] },
    });
  }
  return reply(chatId, "Pastdagi tugmalardan birini tanlang.", { reply_markup: MENU });
}

async function onCallback(query) {
  const chatId = query.message?.chat?.id;
  const answer = (text) => api.enqueue("answerCallbackQuery", { callback_query_id: query.id, ...(text ? { text } : {}) }).catch(() => {});
  if (!chatId || query.message.chat.type !== "private") return answer();
  const user = await userForChat(chatId);
  if (!user) return answer("Avval portal orqali ulaning.");
  const data = String(query.data || "");

  if (data.startsWith("pref:")) {
    const key = data.slice(5);
    if (!applicableKinds(user).includes(key)) return answer();
    const prefs = effectivePrefs(user, user.telegram.prefs);
    const next = { ...(user.telegram.prefs || {}), [key]: !prefs[key] };
    await prisma.telegramLink.update({ where: { userId: user.id }, data: { prefs: next } });
    user.telegram.prefs = next;
    await api
      .enqueue("editMessageReplyMarkup", { chat_id: chatId, message_id: query.message.message_id, reply_markup: settingsMarkup(user) })
      .catch(() => {});
    return answer(next[key] ? "Yoqildi" : "Oʻchirildi");
  }
  // "✅ Bajarildi" under a task message.
  const task = data.match(/^task:done:(\d+)$/);
  if (task) {
    const row = await prisma.task.findUnique({ where: { id: Number(task[1]) } });
    if (!row || row.assigneeId !== user.id) return answer("Bu vazifa sizga emas");
    if (!row.doneAt) {
      const { setDone } = require("../../routes/tasks");
      await setDone(row, user, true);
    }
    const text = `${query.message.text || ""}\n\n✅ Bajarildi`;
    await api.enqueue("editMessageText", { chat_id: chatId, message_id: query.message.message_id, text: text.slice(0, 4000) }).catch(() => {});
    return answer("Bajarildi");
  }
  // "✅ Bajarildi" under a follow-up reminder.
  const followUp = data.match(/^fu:done:(\d+)$/);
  if (followUp) {
    const row = await prisma.clientFollowUp.findUnique({ where: { id: Number(followUp[1]) } });
    if (!row) return answer();
    const mine = row.assigneeId === user.id || (row.assigneeId == null && row.createdById === user.id) || ["BOSS", "DEVELOPER"].includes(user.role);
    if (!mine) return answer("Bu eslatma sizga emas");
    if (row.status === "open") {
      const { syncNextCall } = require("../clientFollowUps");
      await prisma.$transaction(async (tx) => {
        await tx.clientFollowUp.update({ where: { id: row.id }, data: { status: "done", doneAt: new Date(), doneById: user.id } });
        await tx.clientEvent.create({ data: { clientId: row.clientId, caseId: row.caseId, kind: "follow_up", text: "", data: { action: "done", kind: row.kind, dueAt: row.dueAt, via: "telegram" }, authorId: user.id } });
        await syncNextCall(tx, row.clientId);
      });
    }
    const text = `${query.message.text || ""}\n\n✅ Bajarildi`;
    await api.enqueue("editMessageText", { chat_id: chatId, message_id: query.message.message_id, text: text.slice(0, 4000) }).catch(() => {});
    return answer("Bajarildi");
  }
  if (data === "unlink:yes") {
    await answer();
    return disconnect(chatId, user);
  }
  if (data === "unlink:no") {
    await api.enqueue("deleteMessage", { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
    return answer("Bekor qilindi");
  }
  return answer();
}

async function handleUpdate(update) {
  if (update.message) return onMessage(update.message);
  if (update.callback_query) return onCallback(update.callback_query);
  return null;
}

// ------------------------------------------------------------------ polling

let offset = 0;
let stopped = false;

async function poll() {
  let backoff = 2000;
  while (!stopped) {
    try {
      const updates = await api.call("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] }, { timeoutMs: 65000 });
      state.status = "running";
      state.error = null;
      backoff = 2000;
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (err) {
          console.error("[telegram] handling a message failed:", err.message);
        }
      }
    } catch (err) {
      if (err.code === 401 || err.code === 404) {
        state.status = "error";
        state.error = "invalid_token";
        console.error("[telegram] the bot token was rejected — check TELEGRAM_BOT_TOKEN. Receiving stopped.");
        return;
      }
      state.status = "error";
      state.error = err.code === 409 ? "another_server_polling" : "network";
      if (err.code === 409) console.error("[telegram] another server is receiving this bot's messages (TELEGRAM_POLLING=false there).");
      await api.sleep(backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}

async function start() {
  state.startedAt = new Date();
  state.status = "starting";
  // Who the bot is (its @username goes into the "connect" links). Retried
  // until Telegram answers — the server may start before the network.
  for (let attempt = 0; !state.username && !stopped; attempt += 1) {
    try {
      const me = await api.call("getMe");
      state.username = me.username;
    } catch (err) {
      if (err.code === 401 || err.code === 404) {
        state.status = "error";
        state.error = "invalid_token";
        console.error("[telegram] the bot token was rejected — check TELEGRAM_BOT_TOKEN.");
        return;
      }
      state.status = "error";
      state.error = "network";
      await api.sleep(Math.min(5000 * (attempt + 1), 60000));
    }
  }
  console.log(`[telegram] bot @${state.username} ready${env.telegram.polling ? "" : " (sending only: TELEGRAM_POLLING=false)"}`);
  state.status = "running";
  if (!env.telegram.polling) return;
  await api.call("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
  await api
    .call("setMyCommands", {
      commands: [
        { command: "bugun", description: "Bugungi reja" },
        { command: "ertaga", description: "Ertangi uchrashuvlar" },
        { command: "sozlamalar", description: "Qaysi xabarlar kelsin" },
        { command: "yordam", description: "Yordam" },
        { command: "uzish", description: "Botni hisobdan uzish" },
      ],
    })
    .catch(() => {});
  poll();
}

function stop() {
  stopped = true;
}

module.exports = { start, stop, state, handleUpdate, hashCode, MENU };
