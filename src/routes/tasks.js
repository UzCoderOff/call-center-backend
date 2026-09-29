const express = require("express");
const prisma = require("../lib/prisma");
const { events } = require("../lib/events");
const { requireAuth, isManager } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");

// Tasks: work the boss (or the developer) gives one person, with a due time.
//
//   GET    /api/tasks?view=mine|given|all&status=open|done
//            mine (default): given to me · given: that I gave · all: managers
//   GET    /api/tasks/people       who a task can be given to (managers)
//   POST   /api/tasks              { title, notes?, assigneeId, dueAt, clientId? } (managers)
//   PATCH  /api/tasks/:id          done: true/false (the person it's for, or a
//                                  manager); title, notes, dueAt, assigneeId (managers)
//   DELETE /api/tasks/:id          managers
//
// The person gets Telegram messages: when it's given, an hour before it's
// due and when it's due — and can tick it done right there
// (src/services/telegram/). Whoever gave it hears when it's done.
const router = express.Router();
router.use(requireAuth);

const PERSON = { select: { id: true, username: true, name: true, role: true, employee: { select: { name: true } } } };
const TASK_INCLUDE = {
  assignee: PERSON,
  createdBy: PERSON,
  doneBy: PERSON,
  client: { select: { id: true, name: true } },
};
const personName = (u) => (u ? u.employee?.name || u.name || u.username : null);

function publicTask(t) {
  const who = (u) => (u ? { id: u.id, name: personName(u), role: u.role } : null);
  return { ...t, assignee: who(t.assignee), createdBy: who(t.createdBy), doneBy: who(t.doneBy) };
}

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

// An active account a task can be given to.
async function assignee(value) {
  const id = parseId(value, "assigneeId");
  const user = await prisma.user.findUnique({ where: { id }, include: { employee: true } });
  if (!user || !user.active || (user.role === "EMPLOYEE" && user.employee && !user.employee.active)) throw badRequest("unknown assignee");
  return id;
}

async function clientRef(value) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const id = parseId(value, "clientId");
  if (!(await prisma.client.findUnique({ where: { id }, select: { id: true } }))) throw badRequest("unknown client");
  return id;
}

router.get("/", async (req, res, next) => {
  try {
    const manager = isManager(req.user);
    const view = ["given", "all"].includes(req.query.view) && manager ? req.query.view : "mine";
    const done = req.query.status === "done";
    const where = {
      ...(view === "mine" ? { assigneeId: req.user.id } : view === "given" ? { createdById: req.user.id } : {}),
      doneAt: done ? { not: null } : null,
    };
    const rows = await prisma.task.findMany({
      where,
      include: TASK_INCLUDE,
      orderBy: done ? [{ doneAt: "desc" }] : [{ dueAt: "asc" }],
      take: done ? 100 : 300,
    });
    res.json(rows.map(publicTask));
  } catch (err) {
    next(err);
  }
});

// Everyone a task can be given to, grouped the way the form shows them.
router.get("/people", async (req, res, next) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    const users = await prisma.user.findMany({
      where: { active: true },
      include: { employee: { include: { position: { select: { name: true } } } } },
    });
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
    if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    const b = req.body || {};
    const data = {
      title: cleanText(b.title, "title", 200, { required: true }),
      notes: cleanText(b.notes, "notes", 2000) ?? null,
      assigneeId: await assignee(b.assigneeId),
      dueAt: cleanDue(b.dueAt),
      clientId: (await clientRef(b.clientId)) ?? null,
      createdById: req.user.id,
    };
    if (!data.title) throw badRequest("title is required");
    if (!data.dueAt) throw badRequest("invalid dueAt");
    const task = await prisma.task.create({ data, include: TASK_INCLUDE });
    events.emit("task.created", { taskId: task.id });
    res.status(201).json(publicTask(task));
  } catch (err) {
    next(err);
  }
});

// Marks done or not done: the person it's for (or a manager). Shared with the
// Telegram button.
async function setDone(task, user, done) {
  const updated = await prisma.task.update({
    where: { id: task.id },
    data: done ? { doneAt: new Date(), doneById: user.id } : { doneAt: null, doneById: null },
    include: TASK_INCLUDE,
  });
  if (done && !task.doneAt) events.emit("task.done", { taskId: task.id, byUserId: user.id });
  return updated;
}

router.patch("/:id", async (req, res, next) => {
  try {
    const task = await prisma.task.findUnique({ where: { id: parseId(req.params.id) } });
    const manager = isManager(req.user);
    if (!task || (!manager && task.assigneeId !== req.user.id)) throw notFound();
    const b = req.body || {};
    const edits = ["title", "notes", "dueAt", "assigneeId", "clientId"].filter((k) => b[k] !== undefined);
    if (edits.length > 0 && !manager) return res.status(403).json({ error: "forbidden" });
    if (b.done !== undefined && typeof b.done !== "boolean") throw badRequest("invalid done");

    let updated = task;
    if (edits.length > 0) {
      const data = {};
      if (b.title !== undefined) data.title = cleanText(b.title, "title", 200, { required: true });
      if (b.notes !== undefined) data.notes = cleanText(b.notes, "notes", 2000);
      if (b.dueAt !== undefined) data.dueAt = cleanDue(b.dueAt);
      if (b.assigneeId !== undefined) data.assigneeId = await assignee(b.assigneeId);
      if (b.clientId !== undefined) data.clientId = await clientRef(b.clientId);
      updated = await prisma.task.update({ where: { id: task.id }, data });
      // Given to someone else, or moved to a new time: reminders start over.
      if (data.assigneeId !== undefined && data.assigneeId !== task.assigneeId) events.emit("task.created", { taskId: task.id });
      if (data.dueAt !== undefined || data.assigneeId !== undefined) {
        await prisma.telegramNotice.deleteMany({ where: { key: { in: [`task-soon:${task.id}`, `task-due:${task.id}`] } } });
      }
    }
    if (b.done !== undefined) updated = await setDone(updated, req.user, b.done);
    res.json(publicTask(await prisma.task.findUnique({ where: { id: task.id }, include: TASK_INCLUDE })));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    await prisma.task.delete({ where: { id: parseId(req.params.id) } });
    res.status(204).end();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "not_found" });
    next(err);
  }
});

module.exports = router;
module.exports.setDone = setDone;
module.exports.TASK_INCLUDE = TASK_INCLUDE;
