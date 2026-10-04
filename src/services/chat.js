const prisma = require("../lib/prisma");
const { isManager } = require("../middleware/auth");
const { canAccessClient, clientScope } = require("../lib/clientAccess");

// Staff chat (src/routes/chat.js). The firm's rules (2026-10-03):
//
//   everyone  one chat with every active account in it
//   group     only the developer makes them and picks who's in
//   client    a chat on each client, for whoever can see that client
//             (src/lib/clientAccess.js) — checked on every read and write
//   direct    the boss or the developer can write to anyone privately (and
//             they can answer); nobody else starts private chats — staff
//             use Telegram for that
//
// An event card in a chat (Message.eventAt): everyone in the chat gets a
// reminder an hour before and at the start (eventReminders).

const PERSON = { select: { id: true, username: true, name: true, role: true, active: true, employee: { select: { name: true, active: true } } } };
const personName = (u) => (u ? u.employee?.name || u.name || u.username : null);
const isDeveloper = (user) => user?.role === "DEVELOPER";
const canStartDirect = (user) => isManager(user); // BOSS, DEVELOPER

// While someone has the chat open (their read mark moved this recently),
// new messages don't buzz their phone.
const READING_MS = 20 * 1000;

const activeUser = (u) => Boolean(u?.active) && !(u.role === "EMPLOYEE" && u.employee && !u.employee.active);

async function ensureEveryone() {
  const found = await prisma.conversation.findFirst({ where: { kind: "everyone" } });
  return found || prisma.conversation.create({ data: { kind: "everyone" } });
}

// What this person may do in a conversation.
async function access(user, conv) {
  if (!conv || !activeUser(user)) return { read: false, write: false, manage: false };
  switch (conv.kind) {
    case "everyone":
      return { read: true, write: true, manage: false };
    case "group": {
      const member = isDeveloper(user) || (await isMember(conv.id, user.id));
      return { read: member, write: member, manage: isDeveloper(user) };
    }
    case "direct": {
      const member = await isMember(conv.id, user.id);
      return { read: member, write: member, manage: false };
    }
    case "client": {
      const ok = await canAccessClient(user, conv.clientId);
      return { read: ok, write: ok, manage: false };
    }
    default:
      return { read: false, write: false, manage: false };
  }
}

async function isMember(conversationId, userId) {
  return (await prisma.conversationMember.count({ where: { conversationId, userId } })) > 0;
}

// Everyone who belongs in a conversation: { user, member } (member: their
// read mark / mute row, or null).
async function recipients(conv) {
  let users;
  if (conv.kind === "group" || conv.kind === "direct") {
    const rows = await prisma.conversationMember.findMany({ where: { conversationId: conv.id }, include: { user: PERSON } });
    return rows.filter((r) => activeUser(r.user)).map((r) => ({ user: r.user, member: r }));
  }
  users = (await prisma.user.findMany({ where: { active: true }, include: { employee: true } })).filter(activeUser);
  if (conv.kind === "client") {
    const allowed = [];
    for (const u of users) if (await canAccessClient(u, conv.clientId)) allowed.push(u);
    users = allowed;
  }
  const members = await prisma.conversationMember.findMany({ where: { conversationId: conv.id, userId: { in: users.map((u) => u.id) } } });
  const byUser = new Map(members.map((m) => [m.userId, m]));
  return users.map((u) => ({ user: u, member: byUser.get(u.id) || null }));
}

// The name a conversation goes by for this person.
async function displayTitle(conv, viewer) {
  if (conv.kind === "everyone") return "Hamma";
  if (conv.kind === "group") return conv.title || "Guruh";
  if (conv.kind === "client") {
    const client = conv.client || (await prisma.client.findUnique({ where: { id: conv.clientId }, select: { name: true } }));
    return client?.name || "Mijoz";
  }
  if (conv.kind === "direct") {
    const other = await prisma.conversationMember.findFirst({ where: { conversationId: conv.id, NOT: { userId: viewer.id } }, include: { user: PERSON } });
    return personName(other?.user) || "Shaxsiy";
  }
  return "Chat";
}

// The conversations this person sees, newest first (the Everyone chat on top).
async function listFor(user) {
  await ensureEveryone();
  const developer = isDeveloper(user);
  const rows = await prisma.conversation.findMany({
    where: {
      OR: [
        { kind: "everyone" },
        { kind: "group", ...(developer ? {} : { members: { some: { userId: user.id } } }) },
        { kind: "direct", members: { some: { userId: user.id } } },
        { kind: "client", lastMessageAt: { not: null }, client: { is: clientScope(user) } },
      ],
    },
    include: { client: { select: { id: true, name: true } } },
  });
  const marks = await prisma.conversationMember.findMany({ where: { userId: user.id, conversationId: { in: rows.map((r) => r.id) } } });
  const byConv = new Map(marks.map((m) => [m.conversationId, m]));
  const out = [];
  for (const conv of rows) {
    const mark = byConv.get(conv.id);
    const last = await prisma.message.findFirst({ where: { conversationId: conv.id, deletedAt: null }, orderBy: { id: "desc" }, include: { author: PERSON } });
    out.push({
      id: conv.id,
      kind: conv.kind,
      title: await displayTitle(conv, user),
      clientId: conv.clientId,
      lastMessage: last ? { id: last.id, text: last.text, eventTitle: last.eventTitle, author: personName(last.author), mine: last.authorId === user.id, createdAt: last.createdAt } : null,
      lastMessageAt: conv.lastMessageAt,
      unread: await unreadCount(conv.id, user, mark),
      muted: Boolean(mark?.muted),
    });
  }
  return out.sort((a, b) => (a.kind === "everyone" ? -1 : b.kind === "everyone" ? 1 : (b.lastMessageAt?.getTime?.() ?? 0) - (a.lastMessageAt?.getTime?.() ?? 0)));
}

// Messages from others since their read mark — for a newcomer, only since
// their account was made (they don't inherit the Everyone chat's history as
// unread).
async function unreadCount(conversationId, user, mark) {
  return prisma.message.count({
    where: {
      conversationId,
      deletedAt: null,
      id: { gt: mark?.lastReadMessageId ?? 0 },
      createdAt: { gt: user.createdAt ?? new Date(0) },
      NOT: { authorId: user.id },
    },
  });
}

async function totalUnread(user) {
  const list = await listFor(user);
  return list.filter((c) => !c.muted).reduce((sum, c) => sum + c.unread, 0);
}

async function markRead(conversationId, userId, messageId) {
  const existing = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId } } });
  const last = Math.max(existing?.lastReadMessageId ?? 0, messageId ?? 0);
  if (existing) {
    await prisma.conversationMember.update({ where: { id: existing.id }, data: { lastReadMessageId: last, readAt: new Date() } });
  } else {
    await prisma.conversationMember.create({ data: { conversationId, userId, lastReadMessageId: last, readAt: new Date() } });
  }
}

function publicMessage(m, viewer) {
  return {
    id: m.id,
    text: m.deletedAt ? "" : m.text,
    deleted: Boolean(m.deletedAt),
    event: m.eventAt && !m.deletedAt ? { title: m.eventTitle, at: m.eventAt } : null,
    author: m.author ? { id: m.author.id, name: personName(m.author), role: m.author.role } : null,
    mine: m.authorId === viewer.id,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
  };
}

// "Ali: text" for a notification — short.
function preview(message, authorName) {
  const body = message.eventAt ? `📅 ${message.eventTitle}` : message.text;
  const text = body.length > 300 ? `${body.slice(0, 297)}…` : body;
  return authorName ? `${authorName}: ${text}` : text;
}

// A new message -> everyone else in the chat: in the Ledger app, or on
// Telegram for those without it. Not to someone who muted the chat or has
// it open right now.
async function notifyMessage(conv, message, author) {
  const app = require("./notify");
  const { notifyUser } = require("./telegram/notify");
  const f = require("./telegram/format");
  const authorName = personName(author);
  for (const { user, member } of await recipients(conv)) {
    if (user.id === author.id || member?.muted) continue;
    if (member?.readAt && Date.now() - member.readAt.getTime() < READING_MS) continue;
    const title = await displayTitle(conv, user);
    const body = preview(message, conv.kind === "direct" ? null : authorName);
    const link = `/chat/${conv.id}`;
    if (await app.notifyApp(user.id, { kind: "chat", title, body, link, tag: `chat:${conv.id}` })) continue;
    await notifyUser(user.id, "chat", [`💬 <b>${f.escapeHtml(title)}</b>`, f.escapeHtml(body), f.portalLink(link, "Chatni ochish")].join("\n"), undefined, { app: false });
  }
}

// Every minute: event cards an hour before and at the start -> everyone in
// that chat (muted or not — it's a reminder, not chatter). Each once.
async function eventReminders() {
  const app = require("./notify");
  const { notifyUser, once } = require("./telegram/notify");
  const f = require("./telegram/format");
  const { firmNow } = require("../lib/firmTime");
  const now = Date.now();
  const rows = await prisma.message.findMany({
    where: { deletedAt: null, eventAt: { gt: new Date(now - 30 * 60 * 1000), lte: new Date(now + 60 * 60 * 1000) } },
    include: { conversation: { include: { client: { select: { name: true } } } } },
  });
  for (const m of rows) {
    const startsIn = m.eventAt.getTime() - now;
    const stage = startsIn <= 0 ? "now" : "soon";
    // Made less than 5 minutes before the hour mark: the card itself was
    // the news, no "in an hour" on top.
    if (stage === "soon" && m.createdAt.getTime() > now - 5 * 60 * 1000) continue;
    const at = f.clock(firmNow(m.eventAt).minutes);
    await once(`chat-event-${stage}:${m.id}:${m.eventAt.getTime()}`, async () => {
      for (const { user } of await recipients(m.conversation)) {
        const chatTitle = await displayTitle(m.conversation, user);
        const title = stage === "now" ? `📅 ${m.eventTitle} — hozir` : `📅 ${m.eventTitle} — ${at} da`;
        const body = stage === "now" ? `Boshlanish vaqti keldi · ${chatTitle}` : `1 soatdan keyin · ${chatTitle}`;
        const link = `/chat/${m.conversationId}`;
        if (await app.notifyApp(user.id, { kind: "chatEvent", title, body, link, tag: `chat-event:${m.id}` })) continue;
        await notifyUser(user.id, "chat", [`<b>${f.escapeHtml(title)}</b>`, f.escapeHtml(body), f.portalLink(link, "Chatni ochish")].join("\n"), undefined, { app: false });
      }
      return true;
    });
  }
}

module.exports = {
  PERSON,
  personName,
  isDeveloper,
  canStartDirect,
  activeUser,
  ensureEveryone,
  access,
  recipients,
  displayTitle,
  listFor,
  totalUnread,
  markRead,
  publicMessage,
  preview,
  notifyMessage,
  eventReminders,
  READING_MS,
};
