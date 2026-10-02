const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const prisma = require("../lib/prisma");
const env = require("../config/env");
const { requireAuth, isManager, isLawyer } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { firmNow, firmDayRange, shiftDate } = require("../lib/firmTime");
const { requireClientAccess } = require("../lib/clientAccess");
const { INCOMING_DIR, removeQuietly } = require("../utils/fileStorage");
const { events } = require("../lib/events");
const cl = require("../services/clients");
const fu = require("../services/clientFollowUps");
const m = require("../services/materials");
const { canUseClients } = require("./clients");

// The work around a client beyond their cases:
//
//   connected people   POST /api/clients/:id/contacts · PATCH/DELETE /api/client-contacts/:id
//   what happens next  POST /api/clients/:id/follow-ups
//                      GET  /api/client-follow-ups?view=today|overdue|upcoming|all[&scope=mine|team]
//                      GET  /api/client-follow-ups/no-next-step
//                      PATCH /api/client-follow-ups/:id         change / move it
//                      POST /api/client-follow-ups/:id/close    done (what came of it) or cancelled,
//                                                               and maybe the next one at once
//   files              POST /api/clients/:id/files/uploads      start an upload …
//                      PUT  /api/client-files/uploads/:uploadId … send it in pieces …
//                      POST /api/client-files/uploads/:uploadId/finish
//                      GET/PATCH/DELETE /api/client-files/:id
//
// Who: whoever may work on the client (src/lib/clientAccess.js) — not
// someone who only sees a past result. Something about one case (a
// follow-up, a file) is for the people on that case. Every change is on the
// client's timeline.

fs.mkdirSync(env.clientFilesDir, { recursive: true });

const PERSON = { select: { id: true, username: true, name: true, employee: { select: { name: true } } } };
const FILE_KINDS = ["contract", "power_of_attorney", "court_decision", "application", "id_copy", "receipt", "evidence", "other"];
const MAX_FILES_PER_CLIENT = 300;
const CHUNK_BYTES = 900 * 1024;

function fail(status, error) {
  return Object.assign(new Error(error), { status });
}

function sendError(err, res, next) {
  if (err instanceof cl.ClientError) return res.status(400).json({ error: err.message });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  if (err.code === "P2025") return res.status(404).json({ error: "not_found" });
  return next(err);
}

function gate(req, res, next) {
  if (!canUseClients(req.user)) return res.status(403).json({ error: "forbidden" });
  next();
}

const logEvent = (db, { clientId, caseId = null, kind, data, userId }) => db.clientEvent.create({ data: { clientId, caseId, kind, text: "", data, authorId: userId } });
const touch = (db, clientId) => db.client.update({ where: { id: clientId }, data: { updatedAt: new Date() } });

// The case something is about, if it's one this person works on (a manager:
// any of the client's).
async function caseFor(user, clientId, caseId, roles) {
  if (caseId == null || caseId === "") return null;
  const id = parseId(caseId, "caseId");
  const k = await prisma.clientCase.findFirst({ where: { id, clientId }, select: { id: true, status: true } });
  if (!k) throw badRequest("case is not this client's");
  const role = roles.get(id);
  if (!isManager(user) && (!role || role === "result")) throw fail(403, "forbidden");
  return k;
}

// ------------------------------------------------------------ contacts
async function contactFor(req) {
  const contact = await prisma.clientContact.findUnique({ where: { id: parseId(req.params.id) } });
  if (!contact || contact.deletedAt) throw fail(404, "not_found");
  const access = await requireClientAccess(req.user, contact.clientId, { write: true });
  if (access.level === "lawyer") throw fail(403, "forbidden");
  return contact;
}

const RELATION_TEXT = (c) => ({ name: c.name, relation: c.relation });

async function addContact(req, res, next) {
  try {
    const clientId = parseId(req.params.id);
    const { level } = await requireClientAccess(req.user, clientId, { write: true });
    if (level === "lawyer") throw fail(403, "forbidden");
    const count = await prisma.clientContact.count({ where: { clientId, deletedAt: null } });
    if (count >= 30) throw badRequest("too many contacts");
    const data = fu.normalizeContact(req.body);
    const contact = await prisma.$transaction(async (tx) => {
      const c = await tx.clientContact.create({ data: { ...data, clientId, createdById: req.user.id } });
      await logEvent(tx, { clientId, kind: "contact", data: { action: "add", ...RELATION_TEXT(c) }, userId: req.user.id });
      await touch(tx, clientId);
      return c;
    });
    res.status(201).json(contact);
  } catch (err) {
    sendError(err, res, next);
  }
}

const contacts = express.Router();
contacts.use(requireAuth, gate);

contacts.patch("/:id", async (req, res, next) => {
  try {
    const contact = await contactFor(req);
    const data = fu.normalizeContact(req.body, contact);
    const updated = await prisma.$transaction(async (tx) => {
      const c = await tx.clientContact.update({ where: { id: contact.id }, data });
      await logEvent(tx, { clientId: contact.clientId, kind: "contact", data: { action: "edit", ...RELATION_TEXT(c) }, userId: req.user.id });
      return c;
    });
    res.json(updated);
  } catch (err) {
    sendError(err, res, next);
  }
});

// Removed: hidden, kept (and its open follow-ups now about the client).
contacts.delete("/:id", async (req, res, next) => {
  try {
    const contact = await contactFor(req);
    await prisma.$transaction(async (tx) => {
      await tx.clientContact.update({ where: { id: contact.id }, data: { deletedAt: new Date() } });
      await tx.clientFollowUp.updateMany({ where: { contactId: contact.id, status: "open" }, data: { contactId: null } });
      await logEvent(tx, { clientId: contact.clientId, kind: "contact", data: { action: "remove", ...RELATION_TEXT(contact) }, userId: req.user.id });
      await tx.auditLog.create({ data: { userId: req.user.id, action: "contact.delete", entity: "client", entityId: contact.clientId, detail: { contact } } });
    });
    res.status(204).end();
  } catch (err) {
    sendError(err, res, next);
  }
});

// ---------------------------------------------------------- follow-ups
const { FOLLOW_UP_INCLUDE } = fu;

// Who a follow-up is for: yourself; a manager may give it to anyone active.
async function assigneeFor(req, requested) {
  if (requested === undefined || requested === null || requested === "") return req.user.id;
  const id = parseId(requested, "assigneeId");
  if (id === req.user.id) return id;
  if (!isManager(req.user)) throw fail(403, "forbidden");
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, active: true } });
  if (!user?.active) throw badRequest("unknown assignee");
  return id;
}

async function contactOf(clientId, contactId) {
  if (contactId === undefined) return undefined;
  if (contactId === null || contactId === "") return null;
  const c = await prisma.clientContact.findFirst({ where: { id: parseId(contactId, "contactId"), clientId, deletedAt: null }, select: { id: true } });
  if (!c) throw badRequest("contact is not this client's");
  return c.id;
}

async function createFollowUp(db, req, clientId, b, roles) {
  const data = fu.normalizeFollowUp(b, {}, Date.now());
  const kase = await caseFor(req.user, clientId, b.caseId, roles);
  const row = await db.clientFollowUp.create({
    data: {
      ...data,
      clientId,
      caseId: kase?.id ?? null,
      contactId: (await contactOf(clientId, b.contactId)) ?? null,
      assigneeId: await assigneeFor(req, b.assigneeId),
      createdById: req.user.id,
    },
    include: FOLLOW_UP_INCLUDE,
  });
  await logEvent(db, { clientId, caseId: row.caseId, kind: "follow_up", data: { action: "add", kind: row.kind, dueAt: row.dueAt, contact: row.contact ? RELATION_TEXT(row.contact) : null, note: row.note }, userId: req.user.id });
  await fu.syncNextCall(db, clientId);
  await touch(db, clientId);
  return row;
}

async function addFollowUp(req, res, next) {
  try {
    const clientId = parseId(req.params.id);
    const { roles } = await requireClientAccess(req.user, clientId, { write: true });
    const row = await prisma.$transaction((tx) => createFollowUp(tx, req, clientId, req.body || {}, roles));
    if (row.assigneeId && row.assigneeId !== req.user.id) events.emit("followup.assigned", { followUpId: row.id, byUserId: req.user.id });
    res.status(201).json(row);
  } catch (err) {
    sendError(err, res, next);
  }
}

const followUps = express.Router();
followUps.use(requireAuth, gate);

// Someone's list: today (and overdue), overdue only, upcoming (7 days), or
// all open. scope=team (managers): everyone's.
followUps.get("/", async (req, res, next) => {
  try {
    const view = ["today", "overdue", "upcoming", "all"].includes(req.query.view) ? req.query.view : "today";
    const team = req.query.scope === "team" && isManager(req.user);
    const now = firmNow();
    const endOfToday = new Date(firmDayRange(now.date).to);
    const due =
      view === "today" ? { lte: endOfToday } : view === "overdue" ? { lt: new Date() } : view === "upcoming" ? { gt: endOfToday, lte: new Date(firmDayRange(shiftDate(now.date, 7)).to) } : {};
    const rows = await prisma.clientFollowUp.findMany({
      where: { status: "open", dueAt: due, client: { archivedAt: null }, ...(team ? {} : { assigneeId: req.user.id }) },
      orderBy: { dueAt: "asc" },
      take: 200,
      include: FOLLOW_UP_INCLUDE,
    });
    res.json(rows);
  } catch (err) {
    sendError(err, res, next);
  }
});

// Consultations nobody has planned anything for: still open (consultation
// or "call again"), at least a day old, with no open follow-up and no
// appointment coming up. Every open lead should have a next step. An
// operator: their own; managers: everyone's.
followUps.get("/no-next-step", async (req, res, next) => {
  try {
    if (isLawyer(req.user)) return res.json([]);
    const today = firmNow().date;
    const mine = isManager(req.user) ? {} : { operatorId: req.user.employee?.id ?? -1 };
    const rows = await prisma.clientCase.findMany({
      where: {
        ...mine,
        status: { in: ["consultation", "call_again"] },
        OR: [{ startDate: null }, { startDate: { lt: today } }],
        client: {
          archivedAt: null,
          followUps: { none: { status: "open" } },
          appointments: { none: { date: { gte: today }, status: "booked" } },
        },
      },
      orderBy: { updatedAt: "asc" },
      take: 200,
      select: {
        id: true,
        status: true,
        matter: true,
        startDate: true,
        consultationDate: true,
        updatedAt: true,
        operator: { select: { id: true, name: true } },
        client: { select: { id: true, name: true, phones: { select: { phone: true }, orderBy: { id: "asc" }, take: 1 } } },
      },
    });
    res.json(rows);
  } catch (err) {
    sendError(err, res, next);
  }
});

async function followUpFor(req) {
  const row = await prisma.clientFollowUp.findUnique({ where: { id: parseId(req.params.id) } });
  if (!row) throw fail(404, "not_found");
  const { roles, level } = await requireClientAccess(req.user, row.clientId, { write: true });
  if (row.caseId && level !== "manager" && (!roles.get(row.caseId) || roles.get(row.caseId) === "result")) throw fail(404, "not_found");
  // Yours (given to you or by you), one nobody is assigned to, or a manager.
  const mayChange = isManager(req.user) || row.assigneeId === req.user.id || row.createdById === req.user.id || row.assigneeId == null;
  if (!mayChange) throw fail(403, "forbidden");
  return { row, roles };
}

followUps.patch("/:id", async (req, res, next) => {
  try {
    const { row } = await followUpFor(req);
    if (row.status !== "open") throw badRequest("already closed");
    const b = req.body || {};
    const data = fu.normalizeFollowUp(b, row, Date.now());
    const contactId = await contactOf(row.clientId, b.contactId);
    if (contactId !== undefined) data.contactId = contactId;
    if (b.assigneeId !== undefined) data.assigneeId = await assigneeFor(req, b.assigneeId);
    // Moved: it reminds again at the new time.
    if (data.dueAt && data.dueAt.getTime() !== row.dueAt.getTime()) data.remindedAt = null;
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.clientFollowUp.update({ where: { id: row.id }, data, include: FOLLOW_UP_INCLUDE });
      if (data.dueAt && data.dueAt.getTime() !== row.dueAt.getTime()) {
        await logEvent(tx, { clientId: row.clientId, caseId: row.caseId, kind: "follow_up", data: { action: "move", kind: u.kind, dueAt: u.dueAt, before: row.dueAt }, userId: req.user.id });
      }
      await fu.syncNextCall(tx, row.clientId);
      return u;
    });
    res.json(updated);
  } catch (err) {
    sendError(err, res, next);
  }
});

// Done (with what came of it) or cancelled — and, often, the next step at
// once: "no answer, try again tomorrow" ({ next: { kind, dueAt, … } }).
followUps.post("/:id/close", async (req, res, next) => {
  try {
    const { row, roles } = await followUpFor(req);
    if (row.status !== "open") throw badRequest("already closed");
    const close = fu.normalizeClose(req.body);
    const result = await prisma.$transaction(async (tx) => {
      const closed = await tx.clientFollowUp.update({
        where: { id: row.id },
        data: { ...close, doneAt: new Date(), doneById: req.user.id },
        include: FOLLOW_UP_INCLUDE,
      });
      await logEvent(tx, {
        clientId: row.clientId,
        caseId: row.caseId,
        kind: "follow_up",
        data: { action: close.status === "done" ? "done" : "cancel", kind: row.kind, dueAt: row.dueAt, outcome: close.outcome ?? null, outcomeNote: close.outcomeNote ?? null, contact: closed.contact ? RELATION_TEXT(closed.contact) : null },
        userId: req.user.id,
      });
      const following = req.body?.next ? await createFollowUp(tx, req, row.clientId, { caseId: row.caseId, contactId: row.contactId, ...req.body.next }, roles) : null;
      await fu.syncNextCall(tx, row.clientId);
      return { closed, next: following };
    });
    res.json(result);
  } catch (err) {
    sendError(err, res, next);
  }
});

// --------------------------------------------------------------- files
// Uploads in progress (in memory; an interrupted one is simply started
// again; abandoned ones go after an hour). Same pieces as training
// materials, the same file types.
const uploads = new Map();
setInterval(() => {
  for (const [id, u] of uploads) if (Date.now() - u.touchedAt > 60 * 60 * 1000) dropUpload(id);
}, 10 * 60 * 1000).unref();

function dropUpload(id) {
  const u = uploads.get(id);
  if (!u) return;
  uploads.delete(id);
  removeQuietly(u.tempPath);
}

async function startUpload(req, res, next) {
  try {
    const clientId = parseId(req.params.id);
    const { roles } = await requireClientAccess(req.user, clientId, { write: true });
    const b = req.body || {};
    const name = m.cleanFileName(b.name);
    const size = Number(b.size);
    const type = m.fileTypeOf(name);
    if (!type) return res.status(400).json({ error: "file_type_not_allowed" });
    if (!Number.isInteger(size) || size <= 0) throw badRequest("invalid size");
    if (size > m.MAX_FILE_BYTES) return res.status(413).json({ error: "file_too_large", maxBytes: m.MAX_FILE_BYTES });
    if (!FILE_KINDS.includes(b.kind)) throw badRequest("invalid kind");
    const kase = await caseFor(req.user, clientId, b.caseId, roles);
    if ((await prisma.clientFile.count({ where: { clientId, deletedAt: null } })) >= MAX_FILES_PER_CLIENT) return res.status(409).json({ error: "too_many_files" });
    const id = crypto.randomBytes(16).toString("hex");
    const tempPath = path.join(INCOMING_DIR, `client-file-${id}.part`);
    fs.writeFileSync(tempPath, "");
    uploads.set(id, { id, clientId, caseId: kase?.id ?? null, kind: b.kind, title: cl.text(b.title, 200) ?? null, userId: req.user.id, name, size, type, tempPath, received: 0, busy: false, touchedAt: Date.now() });
    res.status(201).json({ uploadId: id, chunkBytes: CHUNK_BYTES });
  } catch (err) {
    sendError(err, res, next);
  }
}

const files = express.Router();
files.use(requireAuth, gate);

function ownUpload(req) {
  const u = uploads.get(String(req.params.uploadId));
  if (!u || u.userId !== req.user.id) throw fail(404, "not_found");
  return u;
}

files.put("/uploads/:uploadId", express.raw({ type: "application/octet-stream", limit: CHUNK_BYTES + 1024 }), async (req, res, next) => {
  let u;
  try {
    u = ownUpload(req);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw badRequest("empty piece");
    if (u.busy || Number(req.query.offset) !== u.received) return res.status(409).json({ error: "wrong_offset", received: u.received });
    if (u.received + req.body.length > u.size) {
      dropUpload(u.id);
      return res.status(400).json({ error: "larger_than_announced" });
    }
    u.busy = true;
    await fs.promises.appendFile(u.tempPath, req.body);
    u.received += req.body.length;
    u.touchedAt = Date.now();
    res.json({ received: u.received });
  } catch (err) {
    sendError(err, res, next);
  } finally {
    if (u) u.busy = false;
  }
});

files.post("/uploads/:uploadId/finish", async (req, res, next) => {
  let u;
  try {
    u = ownUpload(req);
    if (u.busy || u.received !== u.size) return res.status(409).json({ error: "incomplete", received: u.received });
    uploads.delete(u.id);
    const stored = `${u.clientId}-${crypto.randomBytes(10).toString("hex")}${u.type.ext}`;
    fs.renameSync(u.tempPath, path.join(env.clientFilesDir, stored));
    const file = await prisma.$transaction(async (tx) => {
      const f = await tx.clientFile.create({
        data: { clientId: u.clientId, caseId: u.caseId, kind: u.kind, title: u.title, name: u.name, path: stored, mimeType: u.type.mime, size: u.size, uploadedById: u.userId },
        include: { uploadedBy: PERSON },
      });
      await logEvent(tx, { clientId: u.clientId, caseId: u.caseId, kind: "file", data: { action: "add", kind: f.kind, name: f.title || f.name }, userId: u.userId });
      await touch(tx, u.clientId);
      return f;
    });
    const { path: _stored, ...out } = file;
    res.status(201).json(out);
  } catch (err) {
    if (u) removeQuietly(u.tempPath);
    sendError(err, res, next);
  }
});

files.delete("/uploads/:uploadId", (req, res, next) => {
  try {
    dropUpload(ownUpload(req).id);
    res.status(204).end();
  } catch (err) {
    sendError(err, res, next);
  }
});

// A file this person may see: on the client as a whole, or on a case of
// theirs.
async function visibleFile(req, { write = false } = {}) {
  const file = await prisma.clientFile.findUnique({ where: { id: parseId(req.params.id) } });
  if (!file || file.deletedAt) throw fail(404, "not_found");
  const { roles, level } = await requireClientAccess(req.user, file.clientId, { write });
  if (level === "result") throw fail(404, "not_found");
  if (file.caseId && level !== "manager" && (!roles.get(file.caseId) || roles.get(file.caseId) === "result")) throw fail(404, "not_found");
  return file;
}

// Pictures, PDFs, audio and video open in place; office documents (and
// ?download=1) download under their own name.
files.get("/:id", async (req, res, next) => {
  try {
    const file = await visibleFile(req);
    const type = m.fileTypeOf(file.name) || { mime: "application/octet-stream", kind: "document" };
    const absolutePath = path.join(env.clientFilesDir, file.path);
    if (!fs.existsSync(absolutePath)) return res.status(404).json({ error: "file_missing" });
    const download = req.query.download === "1" || type.kind === "document" || type.convert;
    if (download) res.attachment(file.name);
    else res.set("Content-Disposition", "inline");
    res.sendFile(absolutePath, { headers: { "Content-Type": type.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600" } });
  } catch (err) {
    sendError(err, res, next);
  }
});

files.patch("/:id", async (req, res, next) => {
  try {
    const file = await visibleFile(req, { write: true });
    const b = req.body || {};
    const data = {};
    if (b.kind !== undefined) {
      if (!FILE_KINDS.includes(b.kind)) throw badRequest("invalid kind");
      data.kind = b.kind;
    }
    const title = cl.text(b.title, 200);
    if (title !== undefined) data.title = title;
    const updated = await prisma.clientFile.update({ where: { id: file.id }, data, include: { uploadedBy: PERSON } });
    const { path: _stored, ...out } = updated;
    res.json(out);
  } catch (err) {
    sendError(err, res, next);
  }
});

// Removed: hidden from the client's page, kept on disk and in the database
// (the audit log says who) — whoever uploaded it, or a manager.
files.delete("/:id", async (req, res, next) => {
  try {
    const file = await visibleFile(req, { write: true });
    if (file.uploadedById !== req.user.id && !isManager(req.user)) throw fail(403, "forbidden");
    await prisma.$transaction(async (tx) => {
      await tx.clientFile.update({ where: { id: file.id }, data: { deletedAt: new Date() } });
      await logEvent(tx, { clientId: file.clientId, caseId: file.caseId, kind: "file", data: { action: "remove", kind: file.kind, name: file.title || file.name }, userId: req.user.id });
      await tx.auditLog.create({ data: { userId: req.user.id, action: "file.delete", entity: "client", entityId: file.clientId, detail: { fileId: file.id, name: file.name, kind: file.kind } } });
    });
    res.status(204).end();
  } catch (err) {
    sendError(err, res, next);
  }
});

// The routes that hang off a client (/api/clients/:id/…), added to the
// clients router so they share its checks.
function attach(clients) {
  clients.post("/:id/contacts", addContact);
  clients.post("/:id/follow-ups", addFollowUp);
  clients.post("/:id/files/uploads", startUpload);
}

module.exports = { attach, contacts, followUps, files, FILE_KINDS, PERSON, FOLLOW_UP_INCLUDE };
