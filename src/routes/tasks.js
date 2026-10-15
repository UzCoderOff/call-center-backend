const express = require("express");
const prisma = require("../lib/prisma");
const { events } = require("../lib/events");
const { requireAuth, isManager } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { roleOnCase, worksOnCase } = require("../lib/clientAccess");
const { getSetting, setSetting } = require("../lib/settings");
const { firmNow, shiftDate, firmDayRange } = require("../lib/firmTime");

// Tasks: work the boss (or the developer) gives one person, with a due time
// — and a case's own tasks (2026-10-15), which the people on that case give
// each other: lawyers, its coordinator, managers.
//
//   GET    /api/tasks?view=mine|given|all&status=open|done
//            mine (default): given to me · given: that I gave · all: managers
//   GET    /api/tasks?caseId=      a case's tasks, open and done (its people)
//   GET    /api/tasks/people       who a task can be given to (managers);
//                                  ?caseId=: the case's people (its people)
//   POST   /api/tasks              { title, notes?, assigneeId, dueAt, clientId?, caseId? }
//                                  (managers; with caseId also the case's people)
//   PATCH  /api/tasks/:id          done: true/false (the person it's for, a manager, or —
//                                  a case's task — whoever gave it, its lawyers and coordinator);
//                                  title, notes, dueAt, assigneeId (managers, whoever gave a case's task)
//   DELETE /api/tasks/:id          managers; a case's task also whoever gave it
//   GET    /api/tasks/checklists   ready-made lists of a case's usual tasks
//   PUT    /api/tasks/checklists   { lists: [{ id?, name, items: [{ title, days }] }] } (managers)
//   POST   /api/tasks/checklists/:listId/apply  { caseId, assigneeId } — a list's tasks on a case
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
  case: { select: { id: true, matter: true, clientId: true } },
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

// The case a task is about, when this person works on it: { kase, role }.
async function caseFor(user, value) {
  const caseId = parseId(value, "caseId");
  const { kase, role } = await roleOnCase(user, caseId);
  if (!kase || !worksOnCase(role)) throw notFound();
  return { kase, role };
}
// Who on a case may give and tick its tasks.
const TEAM_ROLES = ["manager", "lawyer", "coordinator"];

// The people who work on a case (for its task form, and checks).
async function casePeople(kase) {
  const users = await prisma.user.findMany({ where: { active: true }, include: { employee: true } });
  const { caseRole } = require("../lib/clientAccess");
  return users.filter((u) => (u.role !== "EMPLOYEE" || u.employee?.active) && worksOnCase(caseRole(u, kase, kase.client)));
}

// A line on the case's timeline.
const caseEvent = (task, userId, action) =>
  task.caseId
    ? prisma.clientEvent.create({
        data: { clientId: task.clientId ?? task.case?.clientId, caseId: task.caseId, kind: "task", text: "", authorId: userId, data: { action, title: task.title, taskId: task.id, assignee: personName(task.assignee) } },
      })
    : null;

router.get("/", async (req, res, next) => {
  try {
    if (req.query.caseId !== undefined) {
      const { kase } = await caseFor(req.user, req.query.caseId);
      const [open, done] = await Promise.all([
        prisma.task.findMany({ where: { caseId: kase.id, doneAt: null }, include: TASK_INCLUDE, orderBy: { dueAt: "asc" } }),
        prisma.task.findMany({ where: { caseId: kase.id, doneAt: { not: null } }, include: TASK_INCLUDE, orderBy: { doneAt: "desc" }, take: 50 }),
      ]);
      return res.json([...open, ...done].map(publicTask));
    }
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
    if (req.query.caseId !== undefined) {
      const { kase } = await caseFor(req.user, req.query.caseId);
      // The case's team — the developer looks after everything but isn't on it.
      const team = (await casePeople(kase)).filter((u) => u.role !== "DEVELOPER");
      return res.json(team.map((u) => ({ id: u.id, name: personName(u), role: u.role, position: null })).sort((a, b) => a.name.localeCompare(b.name)));
    }
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
    const b = req.body || {};
    // A case's task: its people give them to each other.
    const onCase = b.caseId !== undefined && b.caseId !== null && b.caseId !== "" ? await caseFor(req.user, b.caseId) : null;
    if (onCase ? !TEAM_ROLES.includes(onCase.role) : !isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    const data = {
      title: cleanText(b.title, "title", 200, { required: true }),
      notes: cleanText(b.notes, "notes", 2000) ?? null,
      assigneeId: await assignee(b.assigneeId),
      dueAt: cleanDue(b.dueAt),
      clientId: onCase ? onCase.kase.clientId : (await clientRef(b.clientId)) ?? null,
      caseId: onCase ? onCase.kase.id : null,
      createdById: req.user.id,
    };
    if (!data.title) throw badRequest("title is required");
    if (!data.dueAt) throw badRequest("invalid dueAt");
    if (onCase && !(await casePeople(onCase.kase)).some((u) => u.id === data.assigneeId)) throw badRequest("not on this case");
    const task = await prisma.task.create({ data, include: TASK_INCLUDE });
    await caseEvent(task, req.user.id, "add");
    events.emit("task.created", { taskId: task.id });
    res.status(201).json(publicTask(task));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------ checklists
// A case's usual tasks, ready to put on it in one go ("Yangi shartnoma":
// get the power of attorney in 2 days…). The firm writes its own lists
// (managers); each item is due `days` after it's put on the case, at 18:00.
const CHECKLISTS_KEY = "caseChecklists";
const DEFAULT_LISTS = {
  lists: [
    {
      id: "new-contract",
      name: "Yangi shartnoma",
      items: [
        { title: "Mijozdan ishonchnoma olish", days: 2 },
        { title: "Hujjatlar nusxasini yigʻish", days: 3 },
        { title: "Mijoz bilan ish rejasini kelishish", days: 5 },
      ],
    },
  ],
};

function cleanLists(value) {
  if (!Array.isArray(value)) throw badRequest("invalid lists");
  const seen = new Set();
  return value.slice(0, 50).map((l, i) => {
    const name = cleanText(l?.name ?? null, "name", 80, { required: true });
    let id = typeof l?.id === "string" && /^[a-z0-9-]{1,40}$/.test(l.id) ? l.id : `list-${Date.now().toString(36)}-${i}`;
    if (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    if (!Array.isArray(l.items) || l.items.length === 0) throw badRequest("a list needs items");
    const items = l.items.slice(0, 40).map((it) => {
      const title = cleanText(it?.title ?? null, "title", 200, { required: true });
      const days = Number(it?.days ?? 0);
      if (!Number.isInteger(days) || days < 0 || days > 365) throw badRequest("invalid days");
      return { title, days };
    });
    return { id, name, items };
  });
}

router.get("/checklists", async (req, res, next) => {
  try {
    res.json(await getSetting(CHECKLISTS_KEY, DEFAULT_LISTS));
  } catch (err) {
    next(err);
  }
});

router.put("/checklists", async (req, res, next) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    const lists = cleanLists(req.body?.lists);
    await setSetting(CHECKLISTS_KEY, { lists }, req.user.id);
    res.json({ lists });
  } catch (err) {
    next(err);
  }
});

router.post("/checklists/:listId/apply", async (req, res, next) => {
  try {
    const { kase, role } = await caseFor(req.user, req.body?.caseId);
    if (!TEAM_ROLES.includes(role)) return res.status(403).json({ error: "forbidden" });
    const { lists } = await getSetting(CHECKLISTS_KEY, DEFAULT_LISTS);
    const list = (lists || []).find((l) => l.id === req.params.listId);
    if (!list) throw notFound();
    const assigneeId = await assignee(req.body?.assigneeId);
    if (!(await casePeople(kase)).some((u) => u.id === assigneeId)) throw badRequest("not on this case");
    const today = firmNow().date;
    const created = [];
    for (const item of list.items) {
      // 18:00 firm time on the day it's due.
      const dueAt = new Date(firmDayRange(shiftDate(today, item.days)).from + 18 * 60 * 60 * 1000);
      const task = await prisma.task.create({
        data: { title: item.title, assigneeId, dueAt, clientId: kase.clientId, caseId: kase.id, createdById: req.user.id },
        include: TASK_INCLUDE,
      });
      events.emit("task.created", { taskId: task.id });
      created.push(task);
    }
    await prisma.clientEvent.create({
      data: { clientId: kase.clientId, caseId: kase.id, kind: "task", text: "", authorId: req.user.id, data: { action: "checklist", title: list.name, count: created.length, assignee: personName(created[0]?.assignee) } },
    });
    res.status(201).json(created.map(publicTask));
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
  if (done && !task.doneAt) {
    events.emit("task.done", { taskId: task.id, byUserId: user.id });
    await caseEvent(updated, user.id, "done");
  }
  return updated;
}

router.patch("/:id", async (req, res, next) => {
  try {
    const task = await prisma.task.findUnique({ where: { id: parseId(req.params.id) } });
    if (!task) throw notFound();
    const manager = isManager(req.user);
    // A case's task: whoever gave it edits it; its lawyers and coordinator
    // may tick it too.
    const team = task.caseId ? await roleOnCase(req.user, task.caseId) : null;
    const giver = Boolean(task.caseId) && task.createdById === req.user.id && worksOnCase(team?.role);
    const ticks = manager || task.assigneeId === req.user.id || giver || (team && TEAM_ROLES.includes(team.role));
    if (!ticks) throw notFound();
    const b = req.body || {};
    const edits = ["title", "notes", "dueAt", "assigneeId", "clientId"].filter((k) => b[k] !== undefined);
    if (edits.length > 0 && !manager && !giver) return res.status(403).json({ error: "forbidden" });
    if (task.caseId && b.clientId !== undefined) return res.status(400).json({ error: "a case's task stays with its client" });
    if (b.done !== undefined && typeof b.done !== "boolean") throw badRequest("invalid done");

    let updated = task;
    if (edits.length > 0) {
      const data = {};
      if (b.title !== undefined) data.title = cleanText(b.title, "title", 200, { required: true });
      if (b.notes !== undefined) data.notes = cleanText(b.notes, "notes", 2000);
      if (b.dueAt !== undefined) data.dueAt = cleanDue(b.dueAt);
      if (b.assigneeId !== undefined) {
        data.assigneeId = await assignee(b.assigneeId);
        if (team?.kase && !(await casePeople(team.kase)).some((u) => u.id === data.assigneeId)) throw badRequest("not on this case");
      }
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
    const task = await prisma.task.findUnique({ where: { id: parseId(req.params.id) } });
    if (!task) throw notFound();
    const giver = Boolean(task.caseId) && task.createdById === req.user.id && worksOnCase((await roleOnCase(req.user, task.caseId)).role);
    if (!isManager(req.user) && !giver) return res.status(403).json({ error: "forbidden" });
    await prisma.task.delete({ where: { id: task.id } });
    res.status(204).end();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "not_found" });
    next(err);
  }
});

module.exports = router;
module.exports.setDone = setDone;
module.exports.TASK_INCLUDE = TASK_INCLUDE;
