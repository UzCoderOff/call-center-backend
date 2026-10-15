const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { requireClientAccess } = require("../lib/clientAccess");
const chat = require("../services/chat");

// Staff chat — the rules are in services/chat.js. Open screens hear about
// changes at once (services/live.js, GET /api/live); phones and browsers
// get a push, Telegram the people with neither.
//
//   GET    /api/chat                      my conversations, unread counts
//   GET    /api/chat/unread               { total, byConv } for the menu badge
//   GET    /api/chat/people               everyone (for groups, private chats)
//   GET    /api/chat/overview             the developer: everyone else's private chats
//   POST   /api/chat/groups               { title, memberIds } (boss, developer)
//   POST   /api/chat/direct               { userId } (anyone) -> the chat with them
//   GET    /api/chat/client/:clientId     the chat on a client (opens it)
//   GET    /api/chat/:id                  one conversation (title, members, what I may do)
//   PATCH  /api/chat/:id                  { title?, memberIds? } groups (who made it, developer)
//   DELETE /api/chat/:id                  groups (who made it, developer)
//   POST   /api/chat/:id/read             { messageId } — read up to there
//   PUT    /api/chat/:id/mute             { muted }
//   GET    /api/chat/:id/messages         ?after=<id> (new ones) | ?before=<id> (older), up to 50; marks read
//   POST   /api/chat/:id/messages         { text, event?: { title, at }, mentions?: [userId] }
//   POST   /api/chat/:id/actions/:mid     { decision: "confirm" | "cancel" } — Ledger AI's
//                                         offer to do something (its owner)
//   PATCH  /api/chat/:id/messages/:mid    { text } (its author)
//   DELETE /api/chat/:id/messages/:mid    its author, or a manager
const router = express.Router();
router.use(requireAuth);

const PAGE = 50;

function notFound() {
  const err = new Error("not_found");
  err.status = 404;
  return err;
}
const forbidden = () => Object.assign(new Error("forbidden"), { status: 403 });

const CONV_INCLUDE = { client: { select: { id: true, name: true } } };

async function conversationFor(req, write = false) {
  const conv = await prisma.conversation.findUnique({ where: { id: parseId(req.params.id) }, include: CONV_INCLUDE });
  if (!conv) throw notFound();
  const can = await chat.access(req.user, conv);
  if (!can.read || (write && !can.write)) throw notFound();
  return { conv, can };
}

function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n/g, "\n").trim();
  return text ? text.slice(0, max) : null;
}

// Active accounts other than me, by name.
async function people(viewer) {
  const users = await prisma.user.findMany({ where: { active: true }, include: { employee: { include: { position: { select: { name: true } } } } } });
  return users
    .filter((u) => chat.activeUser(u) && u.id !== viewer.id)
    .map((u) => ({ id: u.id, name: chat.personName(u), role: u.role, position: u.employee?.position?.name ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function memberIdsFrom(value, creatorId) {
  if (!Array.isArray(value)) throw badRequest("invalid memberIds");
  const ids = [...new Set(value.map((v) => parseId(v, "memberIds")))];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, include: { employee: true } });
  if (users.length !== ids.length || users.some((u) => !chat.activeUser(u))) throw badRequest("unknown member");
  return [...new Set([...ids, creatorId])];
}

// Who's in it, for everyone in it: a group's or private chat's members; the
// Everyone chat: every active account; a client's chat: whoever may see the
// client (for @mentions). The developer looks after every chat but isn't
// one of the people in the shared ones — not listed there (2026-10-15).
const MEMBER_PERSON = { select: { ...chat.PERSON.select, employee: { select: { name: true, active: true, position: { select: { name: true } } } } } };
const memberLine = (u) => ({ id: u.id, name: chat.personName(u), role: u.role, position: u.employee?.position?.name ?? null });

async function membersOf(conv) {
  if (conv.kind === "group" || conv.kind === "direct") {
    return (await prisma.conversationMember.findMany({ where: { conversationId: conv.id }, include: { user: MEMBER_PERSON }, orderBy: { id: "asc" } }))
      .filter((m) => chat.activeUser(m.user))
      .map((m) => memberLine(m.user));
  }
  if (conv.kind === "everyone") {
    const users = await prisma.user.findMany({ where: { active: true }, select: MEMBER_PERSON.select });
    return users.filter((u) => chat.activeUser(u) && !chat.isDeveloper(u)).map(memberLine).sort((a, b) => a.name.localeCompare(b.name));
  }
  if (conv.kind === "client") {
    const ids = (await chat.recipients(conv)).filter((r) => !chat.isDeveloper(r.user)).map((r) => r.user.id);
    const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: MEMBER_PERSON.select });
    return users.map(memberLine).sort((a, b) => a.name.localeCompare(b.name));
  }
  return null;
}

async function describe(conv, user, can) {
  const members = await membersOf(conv);
  const mark = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: conv.id, userId: user.id } } });
  return {
    id: conv.id,
    kind: conv.kind,
    title: await chat.displayTitle(conv, user),
    clientId: conv.clientId,
    members,
    createdById: conv.createdById,
    muted: Boolean(mark?.muted),
    canWrite: can.write,
    canManage: can.manage,
    // The developer reading someone else's private chat (or a group they're
    // not in): no read marks or mutes are kept for them there.
    looking: can.member === false,
  };
}

// Read marks and mutes: everyone's in the Everyone and client chats; in the
// others only for the people in them (the developer looking in doesn't
// become a member).
const keepsMarks = (conv, can) => !["group", "direct", "assistant"].includes(conv.kind) || can.member !== false;

router.get("/", async (req, res, next) => {
  try {
    res.json(await chat.listFor(req.user));
  } catch (err) {
    next(err);
  }
});

router.get("/unread", async (req, res, next) => {
  try {
    res.json(await chat.unreadSummary(req.user));
  } catch (err) {
    next(err);
  }
});

router.get("/people", async (req, res, next) => {
  try {
    res.json(await people(req.user));
  } catch (err) {
    next(err);
  }
});

router.get("/overview", async (req, res, next) => {
  try {
    if (!chat.isDeveloper(req.user)) throw forbidden();
    res.json(await chat.overview(req.user));
  } catch (err) {
    next(err);
  }
});

router.post("/groups", async (req, res, next) => {
  try {
    if (!chat.canMakeGroups(req.user)) throw forbidden();
    const title = cleanText(req.body?.title, 80);
    if (!title) throw badRequest("title is required");
    const memberIds = await memberIdsFrom(req.body?.memberIds, req.user.id);
    const conv = await prisma.conversation.create({
      data: { kind: "group", title, createdById: req.user.id, members: { create: memberIds.map((userId) => ({ userId })) } },
    });
    res.status(201).json(await describe(conv, req.user, await chat.access(req.user, conv)));
  } catch (err) {
    next(err);
  }
});

router.post("/direct", async (req, res, next) => {
  try {
    const otherId = parseId(req.body?.userId, "userId");
    if (otherId === req.user.id) throw badRequest("invalid userId");
    const other = await prisma.user.findUnique({ where: { id: otherId }, include: { employee: true } });
    if (!chat.activeUser(other)) throw badRequest("unknown user");
    // An existing private chat between the two, whoever started it.
    let conv = await prisma.conversation.findFirst({
      where: { kind: "direct", AND: [{ members: { some: { userId: req.user.id } } }, { members: { some: { userId: otherId } } }] },
    });
    if (!conv) {
      if (!chat.canStartDirect(req.user)) throw forbidden();
      conv = await prisma.conversation.create({
        data: { kind: "direct", createdById: req.user.id, members: { create: [{ userId: req.user.id }, { userId: otherId }] } },
      });
    }
    res.json(await describe(conv, req.user, await chat.access(req.user, conv)));
  } catch (err) {
    next(err);
  }
});

router.get("/client/:clientId", async (req, res, next) => {
  try {
    const clientId = parseId(req.params.clientId, "clientId");
    await requireClientAccess(req.user, clientId);
    // Only the people working on the client (not an operator who only sees
    // the result after the contract).
    if (!(await chat.worksOnClient(req.user, clientId))) throw notFound();
    const conv =
      (await prisma.conversation.findUnique({ where: { clientId }, include: { client: { select: { id: true, name: true } } } })) ||
      (await prisma.conversation.create({ data: { kind: "client", clientId, createdById: req.user.id }, include: { client: { select: { id: true, name: true } } } }).catch(async (err) => {
        // Two people opening it at once: the other one made it.
        if (err.code === "P2002") return prisma.conversation.findUnique({ where: { clientId }, include: { client: { select: { id: true, name: true } } } });
        throw err;
      }));
    res.json(await describe(conv, req.user, await chat.access(req.user, conv)));
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const { conv, can } = await conversationFor(req);
    res.json(await describe(conv, req.user, can));
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const { conv, can } = await conversationFor(req);
    if (conv.kind !== "group" || !can.manage) throw forbidden();
    const data = {};
    if (req.body?.title !== undefined) {
      data.title = cleanText(req.body.title, 80);
      if (!data.title) throw badRequest("title is required");
    }
    if (req.body?.memberIds !== undefined) {
      // Whoever changes it stays in it (a developer looking after a group
      // they're not in isn't added).
      const ids = await memberIdsFrom(req.body.memberIds, chat.isDeveloper(req.user) && !can.member ? conv.createdById ?? req.user.id : req.user.id);
      await prisma.conversationMember.deleteMany({ where: { conversationId: conv.id, userId: { notIn: ids } } });
      const have = new Set((await prisma.conversationMember.findMany({ where: { conversationId: conv.id } })).map((m) => m.userId));
      const add = ids.filter((id) => !have.has(id));
      if (add.length) await prisma.conversationMember.createMany({ data: add.map((userId) => ({ conversationId: conv.id, userId })) });
    }
    const updated = Object.keys(data).length ? await prisma.conversation.update({ where: { id: conv.id }, data }) : conv;
    res.json(await describe(updated, req.user, can));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const { conv, can } = await conversationFor(req);
    if (conv.kind !== "group" || !can.manage) throw forbidden();
    await prisma.conversation.delete({ where: { id: conv.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// { messageId } — read up to there (sent in the background; the portal
// has already shown it as read).
router.post("/:id/read", async (req, res, next) => {
  try {
    const { conv, can } = await conversationFor(req);
    if (!keepsMarks(conv, can)) return res.json({ ok: true });
    const messageId = parseId(req.body?.messageId, "messageId");
    await chat.markRead(conv.id, req.user.id, messageId);
    require("../services/live").bump([req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.put("/:id/mute", async (req, res, next) => {
  try {
    const { conv, can } = await conversationFor(req);
    if (!keepsMarks(conv, can)) throw forbidden();
    const muted = req.body?.muted === true;
    await prisma.conversationMember.upsert({
      where: { conversationId_userId: { conversationId: conv.id, userId: req.user.id } },
      update: { muted },
      create: { conversationId: conv.id, userId: req.user.id, muted },
    });
    res.json({ muted });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/messages", async (req, res, next) => {
  try {
    const { conv, can } = await conversationFor(req);
    const after = req.query.after ? parseId(req.query.after, "after") : null;
    const before = req.query.before ? parseId(req.query.before, "before") : null;
    const where = { conversationId: conv.id, ...(after ? { id: { gt: after } } : before ? { id: { lt: before } } : {}) };
    // Newer ones oldest first; older pages (and the first one) from the end.
    const rows = after
      ? await prisma.message.findMany({ where, include: { author: chat.PERSON }, orderBy: { id: "asc" }, take: PAGE })
      : (await prisma.message.findMany({ where, include: { author: chat.PERSON }, orderBy: { id: "desc" }, take: PAGE })).reverse();
    // Edits and deletions since then, for messages already on screen.
    const changed =
      after && req.query.since
        ? await prisma.message.findMany({
            where: { conversationId: conv.id, id: { lte: after }, OR: [{ editedAt: { gt: new Date(Number(req.query.since)) } }, { deletedAt: { gt: new Date(Number(req.query.since)) } }] },
            include: { author: chat.PERSON },
          })
        : [];
    const newest = rows.length ? rows[rows.length - 1].id : null;
    if (!before && newest && keepsMarks(conv, can)) {
      await chat.markRead(conv.id, req.user.id, newest);
      require("../services/live").bump([req.user.id]);
    }
    res.json({
      messages: rows.map((m) => chat.publicMessage(m, req.user)),
      changed: changed.map((m) => chat.publicMessage(m, req.user)),
      hasOlder: !after && rows.length === PAGE,
      serverTime: Date.now(),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/messages", async (req, res, next) => {
  try {
    const { conv, can } = await conversationFor(req, true);
    const b = req.body || {};
    let text = cleanText(b.text, 4000);
    let eventTitle = null;
    let eventAt = null;
    if (b.event && conv.kind === "assistant") throw badRequest("no events here");
    if (b.event) {
      eventTitle = cleanText(b.event.title, 120);
      eventAt = new Date(b.event.at);
      if (!eventTitle) throw badRequest("event title is required");
      if (Number.isNaN(eventAt.getTime()) || eventAt.getTime() < Date.now() - 60 * 1000 || eventAt.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000) {
        throw badRequest("invalid event time");
      }
      text = text || "";
    } else if (!text) {
      throw badRequest("text is required");
    }
    // @mentions: people in this chat, told even when they muted it.
    let data;
    if (Array.isArray(b.mentions) && b.mentions.length && conv.kind !== "assistant") {
      const wanted = new Set(b.mentions.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0 && v !== req.user.id));
      const ids = (await chat.recipients(conv)).map((r) => r.user.id).filter((id) => wanted.has(id));
      if (ids.length) data = { mentions: ids };
    }
    const message = await prisma.message.create({
      data: { conversationId: conv.id, authorId: req.user.id, text, eventTitle, eventAt, ...(data ? { data } : {}) },
      include: { author: chat.PERSON },
    });
    await prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: message.createdAt } });
    // A developer writing in a group they look after but aren't in: no mark.
    if (keepsMarks(conv, can)) await chat.markRead(conv.id, req.user.id, message.id);
    res.status(201).json(chat.publicMessage(message, req.user));
    // Ledger AI: it answers (services/ai/assistant.js) — nobody else to tell.
    if (conv.kind === "assistant") {
      require("../services/live").bump([req.user.id]);
      require("../services/ai/assistant")
        .reply(conv, req.user)
        .catch((err) => console.error("[ai] reply failed:", err.message));
      return;
    }
    // After answering: open screens update at once, then the notifications.
    chat
      .bumpConversation(conv, [req.user.id])
      .catch((err) => console.error("[chat] live update failed:", err.message))
      .then(() => chat.notifyMessage(conv, message, req.user))
      .catch((err) => console.error("[chat] notify failed:", err.message));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/actions/:mid", async (req, res, next) => {
  try {
    const { conv } = await conversationFor(req, true);
    if (conv.kind !== "assistant") throw notFound();
    const decision = req.body?.decision === "cancel" ? "cancel" : req.body?.decision === "confirm" ? "confirm" : null;
    if (!decision) throw badRequest("decision must be confirm or cancel");
    const result = await require("../services/ai/actions").decide(conv, parseId(req.params.mid), req.user, decision);
    res.json(result);
  } catch (err) {
    if (err.toolError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.patch("/:id/messages/:mid", async (req, res, next) => {
  try {
    const { conv } = await conversationFor(req, true);
    const message = await prisma.message.findUnique({ where: { id: parseId(req.params.mid) } });
    if (!message || message.conversationId !== conv.id || message.deletedAt) throw notFound();
    if (message.authorId !== req.user.id) throw forbidden();
    const text = cleanText(req.body?.text, 4000);
    if (!text && !message.eventAt) throw badRequest("text is required");
    const updated = await prisma.message.update({ where: { id: message.id }, data: { text: text || "", editedAt: new Date() }, include: { author: chat.PERSON } });
    res.json(chat.publicMessage(updated, req.user));
    chat.bumpConversation(conv).catch(() => {});
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/messages/:mid", async (req, res, next) => {
  try {
    const { conv, can } = await conversationFor(req);
    const message = await prisma.message.findUnique({ where: { id: parseId(req.params.mid) } });
    if (!message || message.conversationId !== conv.id) throw notFound();
    const { isManager } = require("../middleware/auth");
    // Someone else's message: a manager who may write in this chat (not the
    // developer reading a private chat they aren't in).
    if (message.authorId !== req.user.id && !(isManager(req.user) && can.write)) throw forbidden();
    if (!message.deletedAt) await prisma.message.update({ where: { id: message.id }, data: { deletedAt: new Date() } });
    res.status(204).end();
    chat.bumpConversation(conv).catch(() => {});
  } catch (err) {
    next(err);
  }
});

module.exports = router;
