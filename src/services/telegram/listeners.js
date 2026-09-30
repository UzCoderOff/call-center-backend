const prisma = require("../../lib/prisma");
const { safeOn } = require("../../lib/events");
const { firmNow } = require("../../lib/firmTime");
const m = require("../materials");
const f = require("./format");
const { notifyUser, linkedUsers } = require("./notify");

// Notifications for things happening in the portal, from the events in
// src/lib/events.js. A failure here never affects the booking or save that
// caused it (safeOn).

const APPOINTMENT_INCLUDE = {
  calendar: { select: { id: true, name: true, ownerId: true } },
  bookedBy: { select: { id: true, username: true, name: true, employee: { select: { name: true } } } },
};

function when(a, today) {
  return `${f.relativeDay(a.date, today)}, ${f.clock(a.start)}–${f.clock(a.end)}`;
}

// A new booking in a lawyer's calendar -> the lawyer (unless they booked it
// themselves).
async function onBooked({ appointmentId }) {
  const a = await prisma.appointment.findUnique({ where: { id: appointmentId }, include: APPOINTMENT_INCLUDE });
  if (!a || a.bookedById === a.calendar.ownerId) return;
  const today = firmNow().date;
  const lines = [
    "🗓 <b>Yangi uchrashuv</b>",
    `<b>${when(a, today)}</b>`,
    `Mijoz: ${f.escapeHtml(a.clientName)}`,
    a.format === "online" ? "💻 Onlayn konsultatsiya" : null,
    a.matter ? `Masala: ${f.escapeHtml(a.matter)}` : null,
    `Yozdi: ${f.escapeHtml(f.personName(a.bookedBy))}`,
    f.portalLink("/calendar", "Kalendarni ochish"),
  ];
  await notifyUser(a.calendar.ownerId, "appointments", lines.filter(Boolean).join("\n"));
}

// Cancelled bookings -> whoever booked them ("tell the client", with the
// client's number), and the lawyer when someone else cancelled. One message
// per person even when a changed day cancels several at once.
async function onCancelled({ appointmentIds, byUserId }) {
  const rows = await prisma.appointment.findMany({
    where: { id: { in: appointmentIds }, status: "cancelled" },
    include: APPOINTMENT_INCLUDE,
    orderBy: [{ date: "asc" }, { start: "asc" }],
  });
  if (rows.length === 0) return;
  const today = firmNow().date;
  const by = await prisma.user.findUnique({ where: { id: byUserId }, include: { employee: true } });
  const byName = f.escapeHtml(f.personName(by));

  const forBooker = new Map();
  const forOwner = new Map();
  for (const a of rows) {
    if (a.bookedById !== byUserId) forBooker.set(a.bookedById, [...(forBooker.get(a.bookedById) || []), a]);
    if (a.calendar.ownerId !== byUserId && a.calendar.ownerId !== a.bookedById) {
      forOwner.set(a.calendar.ownerId, [...(forOwner.get(a.calendar.ownerId) || []), a]);
    }
  }

  for (const [userId, list] of forBooker) {
    const items = list.map((a) =>
      [
        `• <b>${when(a, today)}</b> — ${f.escapeHtml(a.clientName)}${a.clientPhone ? `, ${f.escapeHtml(f.phoneCompact(a.clientPhone))}` : ""}`,
        `  ${f.escapeHtml(a.calendar.name)}${a.cancelReason ? ` · Sabab: ${f.escapeHtml(a.cancelReason)}` : ""}`,
      ].join("\n")
    );
    const text = [
      `❌ <b>${list.length > 1 ? `${list.length} ta uchrashuv` : "Uchrashuv"} bekor qilindi — mijozga xabar bering</b>`,
      ...items,
      `Bekor qildi: ${byName}`,
      f.portalLink("/", "Xabar berganingizni belgilash"),
    ];
    await notifyUser(userId, "appointments", text.filter(Boolean).join("\n"));
  }

  for (const [userId, list] of forOwner) {
    const items = list.map((a) => `• ${when(a, today)} — ${f.escapeHtml(a.clientName)}`);
    await notifyUser(userId, "appointments", [`❌ <b>Uchrashuv bekor qilindi</b>`, ...items, `Bekor qildi: ${byName}`].join("\n"));
  }
}

const TASK_INCLUDE = {
  assignee: { include: { employee: true } },
  createdBy: { include: { employee: true } },
  client: { select: { name: true } },
};

// The "✅ Bajarildi" button under a task message.
function taskButton(taskId) {
  return { reply_markup: { inline_keyboard: [[{ text: "✅ Bajarildi", callback_data: `task:done:${taskId}` }]] } };
}

function taskText(task, head) {
  return [
    head,
    `<b>${f.escapeHtml(task.title)}</b>`,
    `Muddat: ${f.moment(task.dueAt)}`,
    task.client ? `Mijoz: ${f.escapeHtml(task.client.name)}` : null,
    task.notes ? f.escapeHtml(task.notes) : null,
    task.createdBy ? `Berdi: ${f.escapeHtml(f.personName(task.createdBy))}` : null,
    f.portalLink("/tasks", "Vazifalarni ochish"),
  ]
    .filter(Boolean)
    .join("\n");
}

// A task given -> the person it's for (not when you give yourself one).
async function onTaskCreated({ taskId }) {
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: TASK_INCLUDE });
  if (!task || task.doneAt || task.assigneeId === task.createdById) return;
  await notifyUser(task.assigneeId, "tasks", taskText(task, "📌 <b>Yangi vazifa</b>"), taskButton(task.id));
}

// Done -> whoever gave it (unless they did it themselves).
async function onTaskDone({ taskId, byUserId }) {
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: TASK_INCLUDE });
  if (!task?.createdById || task.createdById === byUserId) return;
  const by = await prisma.user.findUnique({ where: { id: byUserId }, include: { employee: true } });
  await notifyUser(task.createdById, "tasks", `✅ <b>Vazifa bajarildi</b>\n${f.escapeHtml(task.title)}\n${f.escapeHtml(f.personName(by))}`);
}

// A material the manager announced -> everyone it's for.
async function onMaterial({ materialId }) {
  const material = await prisma.material.findUnique({ where: { id: materialId }, include: { audience: true } });
  if (!material || !material.published || material.archivedAt) return;
  const people = await linkedUsers();
  const text = [
    `📘 <b>${material.version > 1 ? "Material yangilandi" : "Yangi material"}: ${f.escapeHtml(material.title)}</b>`,
    material.category ? f.escapeHtml(material.category) : null,
    material.required ? "Majburiy — oʻqib chiqing va “Oʻqidim” tugmasini bosing." : null,
    f.portalLink(`/materials/${material.id}`, "Materialni ochish"),
  ]
    .filter(Boolean)
    .join("\n");
  for (const person of people) {
    if (m.inAudience(material, person)) await notifyUser(person, "materials", text);
  }
}

function register() {
  safeOn("appointment.booked", onBooked);
  safeOn("appointments.cancelled", onCancelled);
  safeOn("material.published", onMaterial);
  safeOn("task.created", onTaskCreated);
  safeOn("task.done", onTaskDone);
}

module.exports = { register, onBooked, onCancelled, onMaterial, onTaskCreated, onTaskDone, taskText, taskButton, TASK_INCLUDE };
