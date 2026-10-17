const prisma = require("../lib/prisma");
const { phoneKey } = require("../lib/phone");
const { getSetting, setSetting } = require("../lib/settings");
const { isManager, isLawyer, MANAGER_ROLES } = require("../middleware/auth");
const { jobWhere } = require("../lib/jobs");
const { workScope, CONTRACT_STATUSES } = require("../lib/clientAccess");

// Clients writing to the firm's Telegram account (2026-10-15, step 1).
//
// The firm's account (Telegram Premium) has the Ledger bot as its chatbot:
// Telegram → Settings → Telegram Business → Chatbots. Telegram then sends the
// bot every message of the account's private chats — the client's and the
// firm's own replies typed in the Telegram app — as business_message updates
// (services/telegram/bot.js passes them here). Ledger keeps them: one TgChat
// per person, its TgMessages, linked to their client when their number is a
// client's. Nothing is sent from here yet — the operator answers in the
// Telegram app; Ledger sees both sides.
//
// Who sees which chat (the firm's rules, 2026-10-15 and 2026-10-17):
//   - managers: all
//   - the people who answer the firm's Telegram (Sozlamalar → «Mijozlar
//     Telegrami» → who answers): the section, new people (no client yet) and
//     clients without a contract — and the AI's feedback on every chat they
//     see: they share one account, so they share the feedback
//   - a client with a contract: their coordinator and their lawyers, on the
//     client's page only (no section); nobody else. An answerer linking a
//     chat to such a client hands it over.
// The coordinator is told when their client writes.
//
// Settings (Setting "tgInbox"): operatorIds — who answers the firm's Telegram
// (the replies count as theirs when there is just one). Setting "tgBusiness":
// the firm's account the bot is connected to. Any Telegram Premium account
// could add the bot as its chatbot: only the first one connected (the firm's)
// counts — anyone else's messages are dropped, until a manager frees the place
// (Sozlamalar → «Mijozlar Telegrami» → another account).

const SETTINGS_KEY = "tgInbox";
const DEFAULTS = { operatorIds: [] };
const CONNECTION_KEY = "tgBusiness";

// The people a manager picked to answer the firm's Telegram.
async function answererIds() {
  const { operatorIds } = await getSetting(SETTINGS_KEY, DEFAULTS);
  return Array.isArray(operatorIds) ? operatorIds : [];
}
const isAnswerer = async (user) => Boolean(user?.id) && (await answererIds()).includes(user.id);

// The checks below read `user.tgAnswerer`, set first by the routes
// (routes/tgInbox.js, auth) from isAnswerer.
// The section (Mijozlar Telegrami) and new people — linking, new clients,
// hiding: managers and the people who answer.
const seesInbox = (user) => isManager(user) || Boolean(user?.tgAnswerer);
const handlesNew = seesInbox;

// A client in work someone looks after: their coordinator, their lawyer.
function inWorkScope(user) {
  if (isLawyer(user)) return workScope(user);
  const me = user?.employee?.id;
  return me ? { cases: { some: { coordinatorId: me } } } : { id: -1 };
}

// The chats someone may see, as a `where` on TgChat.
function chatScope(user) {
  if (isManager(user)) return {};
  if (user?.tgAnswerer) {
    return { OR: [{ client: { is: workScope(user) } }, { clientId: null }, { client: { is: { cases: { none: { status: { in: CONTRACT_STATUSES } } } } } }] };
  }
  return { client: { is: inWorkScope(user) } };
}

async function canSeeChat(user, chatId) {
  if (isManager(user)) return true;
  return (await prisma.tgChat.count({ where: { AND: [{ id: chatId }, chatScope(user)] } })) > 0;
}

// The people who see chats (for live updates): managers, the answerers,
// coordinators (their clients' page).
async function inboxUserIds() {
  const users = await prisma.user.findMany({
    where: {
      active: true,
      OR: [{ role: { in: MANAGER_ROLES } }, { id: { in: await answererIds() } }, { role: "EMPLOYEE", employee: { active: true, ...jobWhere(["coordinator"]) } }],
    },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

function bumpInbox() {
  inboxUserIds()
    .then((ids) => require("./live").bump(ids))
    .catch(() => {});
}

// ------------------------------------------------------------ messages in

const TEXT_MAX = 4096;
const clip = (value, max = TEXT_MAX) => (value == null ? null : String(value).slice(0, max));

// A Telegram message -> what we keep of it.
function parse(msg) {
  const text = clip(msg.text ?? msg.caption ?? null);
  if (msg.photo?.length) return { kind: "photo", text, fileId: msg.photo[msg.photo.length - 1].file_id };
  if (msg.voice) return { kind: "voice", text, fileId: msg.voice.file_id, duration: msg.voice.duration ?? null };
  if (msg.video_note) return { kind: "video_note", text, fileId: msg.video_note.file_id, duration: msg.video_note.duration ?? null };
  if (msg.video) return { kind: "video", text, fileId: msg.video.file_id, duration: msg.video.duration ?? null, fileName: clip(msg.video.file_name, 200) };
  if (msg.audio) return { kind: "audio", text, fileId: msg.audio.file_id, duration: msg.audio.duration ?? null, fileName: clip(msg.audio.file_name || msg.audio.title, 200) };
  if (msg.document) return { kind: "document", text, fileId: msg.document.file_id, fileName: clip(msg.document.file_name, 200) };
  if (msg.sticker) return { kind: "sticker", text: clip(msg.sticker.emoji, 20) };
  if (msg.contact) {
    const c = msg.contact;
    return { kind: "contact", text: clip([[c.first_name, c.last_name].filter(Boolean).join(" "), c.phone_number].filter(Boolean).join(" · ")) };
  }
  if (msg.location) return { kind: "location", text: `${msg.location.latitude},${msg.location.longitude}` };
  if (msg.text != null) return { kind: "text", text };
  return { kind: "other", text };
}

// An Uzbek mobile number in what they wrote: "+998 90 123 45 67",
// "90-123-45-67", "901234567". Nine digits after an optional 998.
const PHONE_RE = /(?<!\d)(?:\+?\s*998[\s\-()]*)?\(?\d{2}\)?[\s-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/;

function phoneIn(text) {
  const m = PHONE_RE.exec(String(text || ""));
  if (!m) return null;
  const digits = m[0].replace(/\D/g, "");
  const national = digits.length === 12 && digits.startsWith("998") ? digits.slice(3) : digits.length === 9 ? digits : null;
  return national ? `+998${national}` : null;
}

// Their own number: a contact of themselves they shared, else one they typed.
function phoneFrom(msg, tgUserId) {
  const c = msg.contact;
  // A contact without a Telegram account behind it is someone else's (a relative…).
  if (c?.phone_number && c.user_id != null && String(c.user_id) === tgUserId) {
    const digits = c.phone_number.replace(/\D/g, "");
    return digits ? `+${digits}` : null;
  }
  return phoneIn(msg.text ?? msg.caption);
}

// The one client with this number, if there is exactly one.
async function clientByPhone(key) {
  if (!key) return null;
  const rows = await prisma.clientPhone.findMany({ where: { phoneKey: key }, select: { clientId: true } });
  const ids = [...new Set(rows.map((r) => r.clientId))];
  return ids.length === 1 ? ids[0] : null;
}

// The replies are the operator's when one person answers the firm's Telegram.
async function answeringOperator() {
  const { operatorIds } = await getSetting(SETTINGS_KEY, DEFAULTS);
  return Array.isArray(operatorIds) && operatorIds.length === 1 ? operatorIds[0] : null;
}

const names = (chat) => ({
  firstName: clip(chat.first_name, 120),
  lastName: clip(chat.last_name, 120),
  username: clip(chat.username, 64),
});

// Whether a message came through the firm's connection. The first time (or
// after the firm reconnected and Telegram gave a new id), Telegram is asked
// whose connection it is.
async function isFirmConnection(connectionId) {
  if (!connectionId) return false;
  const saved = await getSetting(CONNECTION_KEY, {});
  if (saved.id === connectionId) return Boolean(saved.enabled);
  try {
    const conn = await require("./telegram/api").call("getBusinessConnection", { business_connection_id: connectionId });
    const value = await onConnection(conn);
    return Boolean(value?.enabled && value.id === connectionId);
  } catch (err) {
    console.error("[tg-inbox] unknown business connection:", err.message);
    return false;
  }
}

// business_message / edited_business_message.
async function onMessage(msg, { edited = false } = {}) {
  if (msg?.chat?.type !== "private") return null;
  if (!(await isFirmConnection(msg.business_connection_id))) return null;
  const tgUserId = String(msg.chat.id);
  // In a private chat the chat is the other person: anything not from them
  // was sent by the firm's account (or its bot).
  const out = String(msg.from?.id) !== tgUserId;
  // Telegram Business's own away or greeting message: not anyone's answer.
  const auto = out && Boolean(msg.is_from_offline);
  const sentAt = new Date((msg.date || Date.now() / 1000) * 1000);
  const parsed = parse(msg);
  const connectionId = msg.business_connection_id || null;

  const chat = await prisma.tgChat.upsert({
    where: { tgUserId },
    create: { tgUserId, ...names(msg.chat), connectionId },
    update: { ...names(msg.chat), ...(connectionId ? { connectionId } : {}) },
  });

  if (edited) {
    await prisma.tgMessage.updateMany({
      where: { chatId: chat.id, tgMessageId: msg.message_id },
      data: { text: parsed.text, editedAt: new Date((msg.edit_date || msg.date) * 1000) },
    });
    bumpInbox();
    return chat;
  }

  try {
    await prisma.tgMessage.create({
      data: {
        chatId: chat.id,
        tgMessageId: msg.message_id,
        out,
        auto,
        kind: parsed.kind,
        text: parsed.text,
        fileId: parsed.fileId ?? null,
        fileName: parsed.fileName ?? null,
        duration: parsed.duration ?? null,
        sentAt,
        answeredById: out && !auto ? await answeringOperator() : null,
      },
    });
  } catch (err) {
    if (err.code === "P2002") return chat; // already have it (Telegram sent it again)
    throw err;
  }

  const data = {};
  if (!chat.lastMessageAt || sentAt > chat.lastMessageAt) data.lastMessageAt = sentAt;
  if (out && !auto) {
    data.lastOutAt = sentAt;
    data.waitingSince = null;
  } else if (!out) {
    data.lastInAt = sentAt;
    if (!chat.waitingSince) data.waitingSince = sentAt;
    // The AI took it out of the list; they've written again — a person looks.
    if (chat.aiHidden) Object.assign(data, { hidden: false, aiHidden: false });
    if (!chat.phone) {
      const phone = phoneFrom(msg, tgUserId);
      if (phone) Object.assign(data, { phone, phoneKey: phoneKey(phone) });
    }
  }
  // Their number is a client's: the chat goes with that client (unless a
  // person has already decided whose it is).
  if (!chat.clientId && chat.autoLink) {
    const clientId = await clientByPhone(data.phoneKey || chat.phoneKey);
    if (clientId) data.clientId = clientId;
  }
  const updated = Object.keys(data).length ? await prisma.tgChat.update({ where: { id: chat.id }, data }) : chat;
  bumpInbox();
  if (!out && updated.clientId) tellCoordinators(updated, parsed).catch((err) => console.error("[tg-inbox] coordinator notice failed:", err.message));
  return updated;
}

// A client in work wrote to the firm's Telegram: their coordinator hears (in
// the app, or on Telegram) — once in a while per chat, not every message.
const TOLD_EVERY_MS = 20 * 60 * 1000;
const told = new Map();
async function tellCoordinators(chat, parsed) {
  if (Date.now() - (told.get(chat.id) || 0) < TOLD_EVERY_MS) return;
  const cases = await prisma.clientCase.findMany({
    where: { clientId: chat.clientId, status: { in: CONTRACT_STATUSES }, coordinatorId: { not: null } },
    select: { coordinator: { select: { userId: true } }, client: { select: { name: true } } },
  });
  const userIds = [...new Set(cases.map((k) => k.coordinator?.userId).filter(Boolean))];
  if (!userIds.length) return;
  told.set(chat.id, Date.now());
  const app = require("./notify");
  const { notifyUser } = require("./telegram/notify");
  const f = require("./telegram/format");
  const name = cases[0].client?.name || displayName(chat);
  const title = `Mijozingiz Telegramga yozdi · ${name}`;
  const body = (parsed.text || "").slice(0, 160) || "Yangi xabar";
  // Their client's page: coordinators have no section of their own.
  const link = `/clients/${chat.clientId}`;
  for (const userId of userIds) {
    if (await app.notifyPush(userId, { kind: "chat", title, body, link, tag: `tg:${chat.id}` })) continue;
    await notifyUser(userId, "chat", [`✉️ <b>${f.escapeHtml(title)}</b>`, f.escapeHtml(body), f.portalLink(link, "Yozishmani ochish")].join("\n"), undefined, { app: false });
  }
}

// Whether they're still waiting for an answer: their first message after the
// firm's last reply (deleted ones don't count).
async function refreshWaiting(chatId) {
  const lastOut = await prisma.tgMessage.findFirst({ where: { chatId, out: true, auto: false, deletedAt: null }, orderBy: { id: "desc" }, select: { id: true } });
  const first = await prisma.tgMessage.findFirst({
    where: { chatId, out: false, deletedAt: null, ...(lastOut ? { id: { gt: lastOut.id } } : {}) },
    orderBy: { id: "asc" },
    select: { sentAt: true },
  });
  await prisma.tgChat.update({ where: { id: chatId }, data: { waitingSince: first?.sentAt ?? null } });
}

// deleted_business_messages: kept, marked deleted.
async function onDeleted(update) {
  if (!(await isFirmConnection(update?.business_connection_id))) return 0;
  const chat = await prisma.tgChat.findUnique({ where: { tgUserId: String(update?.chat?.id) } });
  if (!chat || !Array.isArray(update.message_ids)) return 0;
  const { count } = await prisma.tgMessage.updateMany({ where: { chatId: chat.id, tgMessageId: { in: update.message_ids }, deletedAt: null }, data: { deletedAt: new Date() } });
  if (count) await refreshWaiting(chat.id);
  bumpInbox();
  return count;
}

// business_connection: the firm's account connected the bot, changed what it
// may do, or disconnected it.
async function onConnection(conn) {
  if (!conn?.id) return null;
  const saved = await getSetting(CONNECTION_KEY, {});
  if (saved.ownerTgId && saved.ownerTgId !== String(conn.user?.id ?? "")) {
    console.warn("[tg-inbox] another Telegram account tried to connect the bot — ignored");
    return null;
  }
  const rights = conn.rights || {};
  const value = {
    id: conn.id,
    ownerTgId: String(conn.user?.id ?? ""),
    ownerName: [conn.user?.first_name, conn.user?.last_name].filter(Boolean).join(" ") || null,
    ownerUsername: conn.user?.username || null,
    enabled: Boolean(conn.is_enabled),
    canReply: Boolean(rights.can_reply ?? conn.can_reply),
    canRead: Boolean(rights.can_read_messages),
    at: new Date((conn.date || Date.now() / 1000) * 1000).toISOString(),
  };
  await setSetting(CONNECTION_KEY, value, null);
  bumpInbox();
  return value;
}

// ------------------------------------------------------------ reading

const displayName = (c) => [c.firstName, c.lastName].filter(Boolean).join(" ") || (c.username ? `@${c.username}` : "Telegram");

function messageLine(m) {
  return {
    id: m.id,
    out: m.out,
    auto: m.auto,
    kind: m.kind,
    text: m.deletedAt ? null : m.text,
    hasFile: Boolean(m.fileId) && !m.deletedAt,
    fileName: m.fileName,
    duration: m.duration,
    sentAt: m.sentAt,
    edited: Boolean(m.editedAt),
    deleted: Boolean(m.deletedAt),
    answeredBy: m.answeredBy ? m.answeredBy.employee?.name || m.answeredBy.name || m.answeredBy.username : null,
  };
}

function chatLine(c) {
  const last = c.messages?.[0];
  return {
    id: c.id,
    name: displayName(c),
    firstName: c.firstName,
    lastName: c.lastName,
    username: c.username,
    phone: c.phone,
    client: c.client ? { id: c.client.id, name: c.client.name } : null,
    hidden: c.hidden,
    aiHidden: c.aiHidden,
    topic: c.topic,
    lastMessageAt: c.lastMessageAt,
    waitingSince: c.waitingSince,
    lastMessage: last ? { kind: last.kind, text: last.deletedAt ? null : last.text, out: last.out, deleted: Boolean(last.deletedAt), sentAt: last.sentAt } : null,
  };
}

// Telegram gives seconds: messages of the same second in the order they came.
const LAST_MESSAGE = { orderBy: [{ sentAt: "desc" }, { id: "desc" }], take: 1 };
const CLIENT_REF = { select: { id: true, name: true } };

module.exports = {
  SETTINGS_KEY,
  DEFAULTS,
  CONNECTION_KEY,
  seesInbox,
  isAnswerer,
  answererIds,
  handlesNew,
  chatScope,
  canSeeChat,
  inboxUserIds,
  bumpInbox,
  isFirmConnection,
  parse,
  phoneIn,
  phoneFrom,
  onMessage,
  onDeleted,
  onConnection,
  displayName,
  messageLine,
  chatLine,
  LAST_MESSAGE,
  CLIENT_REF,
};
