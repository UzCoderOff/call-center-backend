const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isManager } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { canAccessClient, accessibleClientIds } = require("../lib/clientAccess");
const { REMINDER_INCLUDE, publicReminder, personName, planOne } = require("../services/reminders");

// Reminders: anyone sets them for themselves; the boss and the developer
// also for anyone. At the time the person gets it in the Ledger app and on
// Telegram (services/reminders.js).
//
//   GET    /api/reminders?view=mine|given&status=open|done
//            mine (default): for me · given: that I set for others
//   GET    /api/reminders/people   who a reminder can be for (managers)
//   POST   /api/reminders          { title, notes?, dueAt, userId?, clientId?, phone? }
//   PATCH  /api/reminders/:id      done: true/false (the person it's for);
//                                  title, notes, dueAt, phone (whoever set it, or a manager)
//   DELETE /api/reminders/:id      whoever set it, or a manager
const router = express.Router();
router.use(requireAuth);

function notFound() {
  const err = new Error("not_found");
  err.status = 404;
  return err;
}

function cleanText(value, field, max, { required = false } = {}) {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === "string" && !value.trim())) {
    if (required) throw badRequest(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw badRequest(`invalid ${field}`);
  return value.trim().slice(0, max);
}

function cleanDue(value) {
  if (value === undefined) return undefined;
  const when = new Date(value);
  if (value === null || value === "" || Number.isNaN(when.getTime())) throw badRequest("invalid dueAt");
  return when;
}

function cleanPhone(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^[+\d][\d\s()-]{2,30}$/.test(value.trim())) throw badRequest("invalid phone");
  return value.trim();
}

// Who it's for: yourself, or (boss / developer) any active account.
async function forWhom(req, value) {
  if (value === undefined || value === null || value === "") return req.user.id;
  const id = parseId(value, "userId");
  if (id === req.user.id) return id;
  if (!isManager(req.user)) throw Object.assign(new Error("forbidden"), { status: 403 });
  const user = await prisma.user.findUnique({ where: { id }, include: { employee: true } });
  if (!user || !user.active || (user.role === "EMPLOYEE" && user.employee && !user.employee.active)) throw badRequest("unknown user");
  return id;
}

async function clientRef(req, value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const id = parseId(value, "clientId");
  if (!(await canAccessClient(req.user, id))) throw badRequest("unknown client");
  return id;
}

// The rows as this person may see them: a client they can't open isn't named.
async function forViewer(user, rows) {
  const visible = await accessibleClientIds(user, rows.map((r) => r.clientId));
  return rows.map((r) => publicReminder(r, { clientVisible: !r.clientId || visible.has(r.clientId) }));
}

router.get("/", async (req, res, next) => {
  try {
    const view = req.query.view === "given" ? "given" : "mine";
    const done = req.query.status === "done";
    const where = {
      ...(view === "mine" ? { userId: req.user.id } : { createdById: req.user.id, NOT: { userId: req.user.id } }),
      doneAt: done ? { not: null } : null,
    };
    const rows = await prisma.reminder.findMany({
      where,
      include: REMINDER_INCLUDE,
      orderBy: done ? [{ doneAt: "desc" }] : [{ dueAt: "asc" }],
      take: done ? 100 : 300,
    });
    res.json(await forViewer(req.user, rows));
  } catch (err) {
    next(err);
  }
});

router.get("/people", async (req, res, next) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    const users = await prisma.user.findMany({ where: { active: true }, include: { employee: { include: { position: { select: { name: true } } } } } });
    res.json(
      users
        .filter((u) => u.role !== "EMPLOYEE" || u.employee?.active)
        .map((u) => ({ id: u.id, name: personName(u), role: u.role, position: u.employee?.position?.name ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const b = req.body || {};
    const data = {
      title: cleanText(b.title, "title", 200, { required: true }),
      notes: cleanText(b.notes, "notes", 2000) ?? null,
      dueAt: cleanDue(b.dueAt),
      phone: cleanPhone(b.phone) ?? null,
      userId: await forWhom(req, b.userId),
      clientId: (await clientRef(req, b.clientId)) ?? null,
      createdById: req.user.id,
    };
    if (!data.title) throw badRequest("title is required");
    if (!data.dueAt) throw badRequest("invalid dueAt");
    const row = await prisma.reminder.create({ data, include: REMINDER_INCLUDE });
    planOne(row);
    res.status(201).json((await forViewer(req.user, [row]))[0]);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const row = await prisma.reminder.findUnique({ where: { id: parseId(req.params.id) } });
    const manager = isManager(req.user);
    const mine = row && row.userId === req.user.id;
    const setByMe = row && row.createdById === req.user.id;
    if (!row || (!mine && !setByMe && !manager)) throw notFound();
    const b = req.body || {};
    const edits = ["title", "notes", "dueAt", "phone"].filter((k) => b[k] !== undefined);
    if (edits.length > 0 && !setByMe && !manager) return res.status(403).json({ error: "forbidden" });
    if (b.done !== undefined && typeof b.done !== "boolean") throw badRequest("invalid done");
    if (b.done !== undefined && !mine && !manager) return res.status(403).json({ error: "forbidden" });

    const data = {};
    if (b.title !== undefined) data.title = cleanText(b.title, "title", 200, { required: true });
    if (b.notes !== undefined) data.notes = cleanText(b.notes, "notes", 2000);
    if (b.phone !== undefined) data.phone = cleanPhone(b.phone);
    if (b.dueAt !== undefined) {
      data.dueAt = cleanDue(b.dueAt);
      // A new time: it goes out again then.
      if (data.dueAt.getTime() !== row.dueAt.getTime()) data.sentAt = null;
    }
    if (b.done !== undefined) data.doneAt = b.done ? new Date() : null;
    const updated = await prisma.reminder.update({ where: { id: row.id }, data, include: REMINDER_INCLUDE });
    planOne(updated);
    res.json((await forViewer(req.user, [updated]))[0]);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const row = await prisma.reminder.findUnique({ where: { id: parseId(req.params.id) } });
    if (!row) throw notFound();
    const allowed = row.createdById === req.user.id || isManager(req.user) || (row.userId === req.user.id && row.createdById == null);
    if (!allowed) return res.status(row.userId === req.user.id ? 403 : 404).json({ error: row.userId === req.user.id ? "forbidden" : "not_found" });
    await prisma.reminder.delete({ where: { id: row.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
