const prisma = require("../../lib/prisma");
const env = require("../../config/env");
const { isManager } = require("../../middleware/auth");
const { canSeeFinance } = require("../../lib/finance");
const { firmNow, firmDayRange, isValidDate } = require("../../lib/firmTime");
const { clientScope } = require("../../lib/clientAccess");
const { events } = require("../../lib/events");
const cl = require("../clients");
const fu = require("../clientFollowUps");
const { BUILTIN, BUILTIN_NAMES, FINANCE_ONLY } = require("../performanceMetrics");

// What Ledger AI may DO (2026-10-14: "not that important stuff — reminders,
// tasks, targets — a starting point"). Never at once: the model prepares an
// action, Ledger checks it as the portal would (the same rules as the person
// asking), and it waits in the chat as a card — "Tasdiqlash / Bekor qilish".
// It runs when the person taps Tasdiqlash, or says yes and the model calls
// confirm_action. Each action is a Message in the assistant chat with
// data.action = { tool, args, summary, status, result?, error? }.
//
//   create_reminder  a reminder for themselves or anyone
//   create_task      a task for someone (with a due time; it may ask them to
//                    write an answer)
//   edit_task        an open task's title, notes, due time, person, or
//                    whether it asks for an answer (2026-10-17)
//   add_next_step    a client's next step (call, waiting for a decision…),
//                    for the client's operator unless someone else is named
//   set_target       a person's monthly target on one measure
//   add_client_note  a note on a client's timeline
//
// What it creates shows "Ledger AI" as its author (viaAi; the person who
// confirmed it stays in createdById / authorId) — the firm may later let it
// work on its own. It never deletes anything, touches money or contract
// amounts, or manages accounts.

const nameOf = (u) => u?.employee?.name || u?.name || u?.username || null;

function bad(message) {
  const err = new Error(message);
  err.toolError = true;
  return err;
}

const loose = (s) => cl.searchable(s || "");
const matches = (name, query) => {
  const words = loose(query).split(" ").filter(Boolean);
  const hay = loose(name);
  return words.length > 0 && words.every((w) => hay.includes(w));
};

// One active person by (part of) their name — several: ask which.
async function onePerson(query) {
  const users = await prisma.user.findMany({ where: { active: true }, select: { id: true, username: true, name: true, role: true, employee: { select: { id: true, name: true, active: true } } } });
  const live = users.filter((u) => u.role !== "EMPLOYEE" || u.employee?.active !== false);
  const found = live.filter((u) => matches(nameOf(u), query) || matches(u.username, query));
  if (found.length === 0) throw bad(`nobody is called "${query}"`);
  if (found.length > 1) throw bad(`several people match "${query}": ${found.map(nameOf).join(", ")} — ask which one`);
  return found[0];
}

async function oneClient(user, id) {
  const client = await prisma.client.findFirst({
    where: { AND: [{ id: Number(id) }, clientScope(user)] },
    select: { id: true, name: true, cases: { orderBy: { updatedAt: "desc" }, select: { id: true, matter: true, status: true, operator: { select: { userId: true, name: true } }, coordinator: { select: { userId: true, name: true } } } } },
  });
  if (!client) throw bad("no such client (use search_clients first for the id)");
  return client;
}

// "2026-10-15 14:00" / "2026-10-15T14:00" in Tashkent time (or an ISO time
// with its zone) -> a moment ahead of now.
function moment(value, field = "due") {
  if (typeof value !== "string" || !value.trim()) throw bad(`${field} is required (YYYY-MM-DD HH:MM, Tashkent time)`);
  const s = value.trim();
  let when;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s);
  if (m) {
    if (!isValidDate(m[1])) throw bad(`invalid ${field}`);
    const minutes = m[2] ? Number(m[2]) * 60 + Number(m[3]) : 10 * 60;
    when = new Date(firmDayRange(m[1]).from + minutes * 60 * 1000);
  } else {
    when = new Date(s);
  }
  if (Number.isNaN(when.getTime())) throw bad(`invalid ${field}`);
  if (when.getTime() < Date.now() - 5 * 60 * 1000) throw bad(`${field} is in the past`);
  if (when.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000) throw bad(`${field} is too far ahead`);
  return when;
}

const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: env.firmTimezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const when = (d) => stamp.format(new Date(d));
const text = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

const FOLLOW_UP_WORDS = { call: "qoʻngʻiroq", decision: "qarorini soʻrash", meeting: "uchrashuv", documents: "hujjatlar", payment: "toʻlov", other: "boshqa" };

// ------------------------------------------------------------- the actions
const ACTIONS = {
  create_reminder: {
    description: "Prepare a reminder (shown to the user to confirm first). For the user themselves unless for_person names someone else.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "what to remember, short" },
        due: { type: "string", description: "YYYY-MM-DD HH:MM, Tashkent time" },
        for_person: { type: "string", description: "part of the person's name; leave out for the user themselves" },
        client_id: { type: "integer", description: "a client it's about (id from search_clients), optional" },
        notes: { type: "string" },
      },
      required: ["title", "due"],
    },
    async prepare(a, user) {
      const title = text(a.title, 200);
      if (!title) throw bad("title is required");
      const dueAt = moment(a.due);
      const who = a.for_person ? await onePerson(a.for_person) : null;
      const client = a.client_id ? await oneClient(user, a.client_id) : null;
      const args = { title, notes: text(a.notes, 2000), dueAt: dueAt.toISOString(), userId: who?.id ?? user.id, clientId: client?.id ?? null };
      const summary = `⏰ Eslatma${who && who.id !== user.id ? ` — ${nameOf(who)} uchun` : ""}: «${title}» — ${when(dueAt)}${client ? ` · mijoz: ${client.name}` : ""}`;
      return { args, summary };
    },
    async execute(args, user) {
      const { planOne, REMINDER_INCLUDE } = require("../reminders");
      if (args.userId !== user.id && !isManager(user)) throw bad("forbidden");
      const row = await prisma.reminder.create({ data: { title: args.title, notes: args.notes, dueAt: new Date(args.dueAt), userId: args.userId, clientId: args.clientId, createdById: user.id, viaAi: true }, include: REMINDER_INCLUDE });
      planOne(row);
      return { reminderId: row.id };
    },
  },

  create_task: {
    description:
      "Prepare a task for a staff member, with a due time (shown to the user to confirm first). The person sees Ledger AI as who gave it. Set needs_answer when the task asks them to explain or report something — they then write their answer in Ledger before ticking it done.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        for_person: { type: "string", description: "part of the person's name" },
        due: { type: "string", description: "YYYY-MM-DD HH:MM, Tashkent time" },
        client_id: { type: "integer", description: "optional" },
        notes: { type: "string" },
        needs_answer: { type: "boolean", description: "they must write an answer (explain, report back)" },
      },
      required: ["title", "for_person", "due"],
    },
    async prepare(a, user) {
      const title = text(a.title, 200);
      if (!title) throw bad("title is required");
      const who = await onePerson(a.for_person);
      const dueAt = moment(a.due);
      const client = a.client_id ? await oneClient(user, a.client_id) : null;
      const args = { title, notes: text(a.notes, 2000), assigneeId: who.id, dueAt: dueAt.toISOString(), clientId: client?.id ?? null, needsAnswer: a.needs_answer === true };
      return {
        args,
        summary: `✅ Vazifa — ${nameOf(who)}: «${title}» — muddat ${when(dueAt)}${client ? ` · mijoz: ${client.name}` : ""}${args.needsAnswer ? " · javob yozadi" : ""} · beruvchi: Ledger AI`,
      };
    },
    async execute(args, user) {
      if (!isManager(user)) throw bad("forbidden");
      const task = await prisma.task.create({ data: { ...args, dueAt: new Date(args.dueAt), createdById: user.id, viaAi: true } });
      events.emit("task.created", { taskId: task.id });
      return { taskId: task.id };
    },
  },

  edit_task: {
    description:
      "Prepare a change to an open task (its id from the tasks lookup): a new title, notes, due time, person, or whether they must write an answer. Only what's given changes. Shown to the user to confirm first. Tasks can't be deleted or ticked done from here.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "integer" },
        title: { type: "string" },
        notes: { type: "string" },
        due: { type: "string", description: "YYYY-MM-DD HH:MM, Tashkent time" },
        for_person: { type: "string", description: "part of the new person's name" },
        needs_answer: { type: "boolean" },
      },
      required: ["task_id"],
    },
    async prepare(raw, user) {
      // Models send "" for fields they didn't mean to change.
      const a = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== "" && v !== null));
      const task = await prisma.task.findUnique({ where: { id: Number(a.task_id) }, include: { assignee: { select: { id: true, username: true, name: true, employee: { select: { name: true } } } } } });
      if (!task) throw bad("no such task (use the tasks lookup for its id)");
      if (task.doneAt) throw bad("this task is already done — it can't be changed");
      const changes = {};
      const said = [];
      if (a.title !== undefined) {
        const title = text(a.title, 200);
        if (!title) throw bad("title can't be empty");
        if (title !== task.title) (changes.title = title), said.push(`nomi: «${title}»`);
      }
      if (a.notes !== undefined) {
        const notes = text(a.notes, 2000);
        if (notes !== task.notes) (changes.notes = notes), said.push(notes ? "izoh yangilanadi" : "izoh olib tashlanadi");
      }
      if (a.due !== undefined) {
        const dueAt = moment(a.due);
        if (dueAt.getTime() !== task.dueAt.getTime()) (changes.dueAt = dueAt.toISOString()), said.push(`muddat: ${when(task.dueAt)} → ${when(dueAt)}`);
      }
      if (a.for_person !== undefined) {
        // A case's task stays with the people on that case (routes/tasks.js).
        if (task.caseId) throw bad("a case's task can be given to someone else only on the case page");
        const who = await onePerson(a.for_person);
        if (who.id !== task.assigneeId) (changes.assigneeId = who.id), said.push(`kimga: ${nameOf(task.assignee)} → ${nameOf(who)}`);
      }
      if (typeof a.needs_answer === "boolean" && a.needs_answer !== task.needsAnswer) (changes.needsAnswer = a.needs_answer), said.push(a.needs_answer ? "javob yozadi" : "javob shart emas");
      if (said.length === 0) throw bad("nothing would change");
      return { args: { taskId: task.id, changes }, summary: `✏️ Vazifa oʻzgaradi — ${nameOf(task.assignee)}: «${task.title}» · ${said.join(" · ")}` };
    },
    async execute(args, user) {
      if (!isManager(user)) throw bad("forbidden");
      const task = await prisma.task.findUnique({ where: { id: args.taskId } });
      if (!task) throw bad("the task is gone");
      if (task.doneAt) throw bad("the task was done meanwhile");
      const { changes } = args;
      const data = { ...changes, ...(changes.dueAt ? { dueAt: new Date(changes.dueAt) } : {}) };
      // Someone else's now: the answer was the last person's.
      if (data.assigneeId !== undefined && data.assigneeId !== task.assigneeId) Object.assign(data, { answer: null, answeredAt: null });
      await prisma.task.update({ where: { id: task.id }, data });
      // As the tasks page does: a new person hears about it; a new time or
      // person gets its reminders again.
      if (data.assigneeId !== undefined && data.assigneeId !== task.assigneeId) events.emit("task.created", { taskId: task.id });
      if (data.dueAt !== undefined || data.assigneeId !== undefined) {
        await prisma.telegramNotice.deleteMany({ where: { key: { in: [`task-soon:${task.id}`, `task-due:${task.id}`] } } });
      }
      return { taskId: task.id };
    },
  },

  add_next_step: {
    description:
      "Prepare a client's next step (call them, wait for their decision, a meeting, documents, a payment) with a due time — for the client's operator (or coordinator after the contract) unless for_person names someone. Shown to the user to confirm first.",
    parameters: {
      type: "object",
      properties: {
        client_id: { type: "integer" },
        kind: { type: "string", enum: fu.FOLLOW_UP_KINDS },
        due: { type: "string", description: "YYYY-MM-DD HH:MM, Tashkent time" },
        note: { type: "string" },
        for_person: { type: "string", description: "optional: part of a person's name" },
      },
      required: ["client_id", "kind", "due"],
    },
    async prepare(a, user) {
      const client = await oneClient(user, a.client_id);
      if (!fu.FOLLOW_UP_KINDS.includes(a.kind)) throw bad("invalid kind");
      const dueAt = moment(a.due);
      const latest = client.cases[0];
      const who = a.for_person ? await onePerson(a.for_person) : null;
      const assigneeId = who?.id ?? latest?.coordinator?.userId ?? latest?.operator?.userId ?? user.id;
      const assigneeName = who ? nameOf(who) : latest?.coordinator?.name ?? latest?.operator?.name ?? "siz";
      const args = { clientId: client.id, caseId: latest?.id ?? null, kind: a.kind, dueAt: dueAt.toISOString(), note: text(a.note, 1000), assigneeId };
      return { args, summary: `📌 Keyingi qadam — ${client.name}: ${FOLLOW_UP_WORDS[a.kind]}, ${when(dueAt)} · masʼul: ${assigneeName}${args.note ? ` · ${args.note}` : ""}` };
    },
    async execute(args, user) {
      const row = await prisma.$transaction(async (tx) => {
        const r = await tx.clientFollowUp.create({ data: { ...args, dueAt: new Date(args.dueAt), createdById: user.id, viaAi: true } });
        await tx.clientEvent.create({ data: { clientId: args.clientId, caseId: args.caseId, kind: "follow_up", text: "", data: { action: "add", kind: r.kind, dueAt: r.dueAt, note: r.note, viaAi: true }, authorId: user.id } });
        await fu.syncNextCall(tx, args.clientId);
        return r;
      });
      if (row.assigneeId && row.assigneeId !== user.id) events.emit("followup.assigned", { followUpId: row.id, byUserId: user.id });
      return { followUpId: row.id };
    },
  },

  set_target: {
    description:
      "Prepare a staff member's monthly target on one measure (from a month on, until changed; 0 = no target). Measures: consultations (the consultations they book in the calendar — bookings are consultations), contracts, calls_answered, fees (consultation fees, soʻm), collected, cases, income (all income — finance only). Shown to the user to confirm first.",
    parameters: {
      type: "object",
      properties: {
        employee: { type: "string", description: "part of the employee's name" },
        metric: { type: "string", enum: BUILTIN },
        amount: { type: "integer", description: "pieces, or soʻm for money measures" },
        month: { type: "string", description: "YYYY-MM, default this month" },
      },
      required: ["employee", "metric", "amount"],
    },
    async prepare(a, user) {
      if (!BUILTIN.includes(a.metric)) throw bad("unknown measure");
      if ((FINANCE_ONLY.has(a.metric) || a.metric === "collected") && !canSeeFinance(user)) throw bad("finance is not available to this person");
      const amount = Number(a.amount);
      if (!Number.isInteger(amount) || amount < 0 || amount > 10_000_000_000) throw bad("invalid amount");
      const month = a.month || firmNow().date.slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad("month must be YYYY-MM");
      const all = await prisma.employee.findMany({ where: { active: true }, select: { id: true, name: true } });
      const found = all.filter((e) => matches(e.name, a.employee));
      if (found.length === 0) throw bad(`no employee is called "${a.employee}"`);
      if (found.length > 1) throw bad(`several match "${a.employee}": ${found.map((e) => e.name).join(", ")} — ask which one`);
      const e = found[0];
      const args = { employeeId: e.id, metric: a.metric, amount, fromMonth: month };
      return { args, summary: `🎯 Reja — ${e.name}: ${BUILTIN_NAMES[a.metric]} — ${amount === 0 ? "reja yoʻq" : amount.toLocaleString("ru-RU").replace(/,/g, " ")} (${month} dan)` };
    },
    async execute(args, user) {
      if (!isManager(user)) throw bad("forbidden");
      const { employeeId, metric, amount, fromMonth } = args;
      await prisma.target.upsert({
        where: { employeeId_metric_fromMonth: { employeeId, metric, fromMonth } },
        create: { employeeId, metric, amount, fromMonth, setById: user.id },
        update: { amount, setById: user.id },
      });
      events.emit("targets.set", { employeeId, fromMonth, byUserId: user.id });
      return { ok: true };
    },
  },

  add_client_note: {
    description: "Prepare a note on a client's timeline (shown to the user to confirm first).",
    parameters: { type: "object", properties: { client_id: { type: "integer" }, text: { type: "string" } }, required: ["client_id", "text"] },
    async prepare(a, user) {
      const client = await oneClient(user, a.client_id);
      const note = text(a.text, 4000);
      if (!note) throw bad("text is required");
      return { args: { clientId: client.id, text: note }, summary: `📝 Izoh — ${client.name}: «${note.length > 160 ? `${note.slice(0, 157)}…` : note}»` };
    },
    async execute(args, user) {
      await prisma.clientEvent.create({ data: { clientId: args.clientId, kind: "note", text: args.text, data: { viaAi: true }, authorId: user.id } });
      await prisma.client.update({ where: { id: args.clientId }, data: { updatedAt: new Date() } });
      return { ok: true };
    },
  },
};

const STATUS_WORDS = { done: "✅ Bajarildi", cancelled: "✖️ Bekor qilindi", failed: "⚠️ Bajarilmadi" };

// The model's side: prepare one (saved as a card in the chat) …
async function prepare(name, rawArgs, user, conv) {
  const action = ACTIONS[name];
  if (!action || !isManager(user)) return { error: `unknown tool ${name}` };
  try {
    const { args, summary } = await action.prepare(rawArgs || {}, user);
    const message = await prisma.message.create({
      data: { conversationId: conv.id, authorId: null, text: summary, data: { action: { tool: name, args, summary, status: "pending" } } },
    });
    await prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: message.createdAt } });
    require("../live").bump([user.id]);
    return {
      prepared: true,
      action_id: message.id,
      summary,
      next: "Shown to the user as a card with Tasdiqlash / Bekor qilish. Tell them in one short sentence what will happen and ask them to confirm. Call confirm_action only after they clearly say yes.",
    };
  } catch (err) {
    if (err.toolError) return { error: err.message };
    throw err;
  }
}

// Actions being run right now (one server process): a tap on the card and
// the model's confirm_action at the same moment run it once.
const deciding = new Set();

// … and run it (or drop it) — from the card's buttons or confirm_action.
// `fromModel`: the model asking — it may only confirm once the person has
// written something after the card appeared (their "ha"), never in the
// same turn that prepared it.
async function decide(conv, messageId, user, decision, { fromModel = false } = {}) {
  const id = Number(messageId);
  const load = () => prisma.message.findUnique({ where: { id } });
  let message = await load();
  const action = message?.data?.action;
  if (!message || message.conversationId !== conv.id || !action) throw bad("no such action");
  if (action.status !== "pending") return { status: action.status, summary: action.summary, already: true };
  if (fromModel && decision === "confirm") {
    const answered = await prisma.message.count({ where: { conversationId: conv.id, authorId: user.id, deletedAt: null, id: { gt: id } } });
    if (!answered) throw bad("the user hasn't answered yet — ask them to confirm first, and call confirm_action only after their yes");
  }
  if (deciding.has(id)) return { status: "pending", summary: action.summary, busy: true };
  deciding.add(id);
  try {
    // Decided meanwhile?
    message = await load();
    const current = message.data?.action;
    if (current?.status !== "pending") return { status: current?.status, summary: action.summary, already: true };
    let next;
    if (decision === "cancel") next = { ...current, status: "cancelled" };
    else {
      try {
        const result = await ACTIONS[current.tool].execute(current.args, user);
        next = { ...current, status: "done", result };
      } catch (err) {
        next = { ...current, status: "failed", error: err.toolError ? err.message : "error" };
        if (!err.toolError) console.error(`[ai] action ${current.tool} failed:`, err.message);
      }
    }
    await prisma.message.update({ where: { id }, data: { data: { action: next }, text: `${STATUS_WORDS[next.status]} — ${current.summary}`, editedAt: new Date() } });
    require("../live").bump([user.id]);
    return { status: next.status, summary: current.summary, error: next.error };
  } finally {
    deciding.delete(id);
  }
}

// confirm_action / cancel_action, for the model.
const CONTROL = [
  {
    name: "confirm_action",
    description: "Run an action prepared before (its action_id) — ONLY after the user clearly said yes to it.",
    parameters: { type: "object", properties: { action_id: { type: "integer" } }, required: ["action_id"] },
  },
  {
    name: "cancel_action",
    description: "Drop an action prepared before, when the user says no or changes their mind.",
    parameters: { type: "object", properties: { action_id: { type: "integer" } }, required: ["action_id"] },
  },
];

const definitions = (user) =>
  isManager(user) ? [...Object.entries(ACTIONS).map(([name, a]) => ({ name, description: a.description, parameters: a.parameters })), ...CONTROL] : [];

const handles = (name) => Boolean(ACTIONS[name]) || CONTROL.some((c) => c.name === name);

async function run(name, args, user, conv) {
  if (ACTIONS[name]) return prepare(name, args, user, conv);
  try {
    if (name === "confirm_action") return await decide(conv, args.action_id, user, "confirm", { fromModel: true });
    if (name === "cancel_action") return await decide(conv, args.action_id, user, "cancel", { fromModel: true });
  } catch (err) {
    if (err.toolError) return { error: err.message };
    throw err;
  }
  return { error: `unknown tool ${name}` };
}

module.exports = { ACTIONS, definitions, handles, run, decide, prepare, moment };
