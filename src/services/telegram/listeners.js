const prisma = require("../../lib/prisma");
const { safeOn } = require("../../lib/events");
const { firmNow } = require("../../lib/firmTime");
const m = require("../materials");
const f = require("./format");
const { notifyUser, linkedUsers } = require("./notify");
const { BUILTIN_NAMES, FINANCE_ONLY, parseKey, formMeasures, targetsFor } = require("../performanceMetrics");

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

// A monthly plan set for someone (Natijalar) -> them: everything they're
// measured on from that month. All income without soʻm — staff don't see
// contract money (src/lib/finance.js).
async function onTargetsSet({ employeeId, fromMonth, byUserId }) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId }, include: { position: true } });
  if (!employee?.userId || employee.userId === byUserId) return;
  const targets = (await targetsFor([employee], fromMonth)).get(employee.id);
  if (!targets?.size) return;
  const formIds = [...new Set([...targets.keys()].map((k) => parseKey(k)?.templateId).filter(Boolean))];
  const forms = formIds.length ? await prisma.reportTemplate.findMany({ where: { id: { in: formIds } }, select: { id: true, name: true, fields: true } }) : [];
  const measures = new Map(forms.flatMap(formMeasures).map((m) => [m.key, m]));
  const count = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const lines = [...targets].map(([key, amount]) => {
    if (FINANCE_ONLY.has(key)) return `• ${BUILTIN_NAMES[key]} — bajarilishi Natijalarda foizda koʻrinadi`;
    const m = measures.get(key);
    const money = key === "fees" || m?.unit === "money";
    return `• ${f.escapeHtml(BUILTIN_NAMES[key] || m?.label || key)}: <b>${money ? f.money(amount) : count(amount)}</b>`;
  });
  const [y, mo] = fromMonth.split("-").map(Number);
  const by = await prisma.user.findUnique({ where: { id: byUserId }, include: { employee: true } });
  const text = [
    "🎯 <b>Sizga oylik reja qoʻyildi</b>",
    `${f.MONTHS[mo - 1].replace(/^./, (c) => c.toUpperCase())} ${y} dan:`,
    ...lines,
    by ? `Qoʻydi: ${f.escapeHtml(f.personName(by))}` : null,
    f.portalLink(`/performance/${employee.id}`, "Natijalarni ochish"),
  ];
  await notifyUser(employee.userId, "targets", text.filter(Boolean).join("\n"));
}

const CASE_INCLUDE = {
  client: { select: { id: true, name: true } },
  operator: { select: { name: true } },
  coordinator: { select: { name: true, userId: true } },
};

const caseLine = (k) => `${f.escapeHtml(k.client.name)}${k.matter ? ` — ${f.escapeHtml(k.matter)}` : ""}`;

// A contract signed -> the managers: the case needs its coordinator and
// lawyer (unless it already has both).
async function onContract({ caseId, byUserId }) {
  const k = await prisma.clientCase.findUnique({ where: { id: caseId }, include: CASE_INCLUDE });
  if (!k) return;
  const missing = [!k.coordinatorId ? "koordinator" : null, !k.lawyerId ? "advokat" : null].filter(Boolean);
  const by = await prisma.user.findUnique({ where: { id: byUserId }, include: { employee: true } });
  const text = [
    "✍️ <b>Shartnoma tuzildi</b>",
    caseLine(k),
    k.operator ? `Operator: ${f.escapeHtml(k.operator.name)}` : null,
    missing.length ? `Tayinlash kerak: ${missing.join(" va ")}` : null,
    by ? `Belgiladi: ${f.escapeHtml(f.personName(by))}` : null,
    f.portalLink(`/clients/${k.client.id}`, "Mijozni ochish"),
  ];
  for (const user of await linkedUsers({ role: { in: ["BOSS", "DEVELOPER"] } })) {
    if (user.id === byUserId) continue;
    await notifyUser(user, "cases", text.filter(Boolean).join("\n"));
  }
}

// A case handed to someone -> them (unless they did it themselves).
async function onAssigned({ caseId, role, byUserId }) {
  const k = await prisma.clientCase.findUnique({ where: { id: caseId }, include: CASE_INCLUDE });
  if (!k) return;
  const userId = role === "coordinator" ? k.coordinator?.userId : k.lawyerId;
  if (!userId || userId === byUserId) return;
  const by = await prisma.user.findUnique({ where: { id: byUserId }, include: { employee: true } });
  const text = [
    "📁 <b>Sizga ish biriktirildi</b>",
    caseLine(k),
    role === "coordinator" ? "Siz — koordinator: toʻlovlar, muddatlar va mijoz bilan aloqa." : "Siz — advokat.",
    by ? `Biriktirdi: ${f.escapeHtml(f.personName(by))}` : null,
    f.portalLink(`/clients/${k.client.id}`, "Ishni ochish"),
  ];
  await notifyUser(userId, "cases", text.filter(Boolean).join("\n"));
}

const FOLLOW_UP_WORDS = { call: "Qoʻngʻiroq qilish", decision: "Qaror muddati", meeting: "Uchrashuv", documents: "Hujjatlar", payment: "Toʻlov", other: "Eslatma" };
const RELATION_WORDS = { father: "otasi", mother: "onasi", spouse: "turmush oʻrtogʻi", child: "farzandi", sibling: "aka-ukasi/opa-singlisi", relative: "qarindoshi", representative: "vakili", friend: "doʻsti", colleague: "hamkasbi", other: "aloqador" };

// One follow-up as a Telegram message: what, about whom, who to call, why.
function followUpText(row, head) {
  const phone = row.contact?.phone || row.client.phones[0]?.phone;
  const who = row.contact ? `${f.escapeHtml(row.contact.name)} (${RELATION_WORDS[row.contact.relation] || "aloqador"})` : null;
  return [
    head,
    `<b>${FOLLOW_UP_WORDS[row.kind] || FOLLOW_UP_WORDS.other}</b> — ${f.escapeHtml(row.client.name)}`,
    who ? `Kim bilan: ${who}` : null,
    phone ? `Tel: ${f.escapeHtml(f.phoneCompact(phone))}` : null,
    row.note ? f.escapeHtml(row.note) : null,
    `Muddat: ${f.moment(row.dueAt)}`,
    f.portalLink(`/clients/${row.client.id}`, "Mijozni ochish"),
  ]
    .filter(Boolean)
    .join("\n");
}

function followUpButton(id) {
  return { reply_markup: { inline_keyboard: [[{ text: "✅ Bajarildi", callback_data: `fu:done:${id}` }]] } };
}

const FOLLOW_UP_MESSAGE_INCLUDE = {
  contact: { select: { name: true, relation: true, phone: true } },
  client: { select: { id: true, name: true, phones: { select: { phone: true }, orderBy: { id: "asc" }, take: 1 } } },
};

// A follow-up given to someone else -> them.
async function onFollowUpAssigned({ followUpId }) {
  const row = await prisma.clientFollowUp.findUnique({ where: { id: followUpId }, include: FOLLOW_UP_MESSAGE_INCLUDE });
  if (!row?.assigneeId || row.status !== "open") return;
  await notifyUser(row.assigneeId, "followUps", followUpText(row, "📝 <b>Sizga eslatma qoʻyildi</b>"), followUpButton(row.id));
}

// A strike -> the person (with where they stand this month), and the
// managers once they're over the limit.
async function onStrike({ strikeId }) {
  const { strikeCounts } = require("../strikes");
  const strike = await prisma.strike.findUnique({ where: { id: strikeId }, include: { employee: { select: { id: true, name: true, userId: true } }, callLog: { select: { phoneNumber: true } } } });
  if (!strike || strike.cancelledAt) return;
  const { rules, counts } = await strikeCounts([strike.employeeId], strike.month);
  const c = counts.get(strike.employeeId);
  const [y, mo] = strike.month.split("-").map(Number);
  const monthName = `${f.MONTHS[mo - 1]} ${y}`;
  const late = strike.answeredAt ? `qayta qoʻngʻiroq: ${f.moment(strike.answeredAt)}` : "qayta qoʻngʻiroq qilinmadi";
  if (strike.employee.userId) {
    await notifyUser(
      strike.employee.userId,
      "strikes",
      [
        `⚠️ <b>Ogohlantirish ${c.count}/${rules.limit}</b> (${monthName})`,
        `${f.escapeHtml(f.phoneCompact(strike.callLog.phoneNumber))} — ${f.moment(strike.missedAt)} dagi javobsiz qoʻngʻiroq; ${late}.`,
        `Qoida: javobsiz qoʻngʻiroqqa ${rules.minutes} daqiqa ichida qayta qoʻngʻiroq qiling.`,
      ].join("\n")
    );
  }
  if (c.count > rules.limit) {
    const text = [
      `🚫 <b>${f.escapeHtml(strike.employee.name)} — ${monthName}: ${c.count}-ogohlantirish</b> (chegara ${rules.limit})`,
      c.fine > 0 ? `Jarima (chegaradan oshgani uchun): ${f.money(c.fine)}` : null,
      f.portalLink(`/performance/${strike.employee.id}`, "Natijalarni ochish"),
    ]
      .filter(Boolean)
      .join("\n");
    for (const user of await linkedUsers({ role: { in: ["BOSS", "DEVELOPER"] } })) await notifyUser(user, "strikes", text);
  }
}

function register() {
  safeOn("appointment.booked", onBooked);
  safeOn("appointments.cancelled", onCancelled);
  safeOn("material.published", onMaterial);
  safeOn("task.created", onTaskCreated);
  safeOn("task.done", onTaskDone);
  safeOn("targets.set", onTargetsSet);
  safeOn("case.contract", onContract);
  safeOn("case.assigned", onAssigned);
  safeOn("followup.assigned", onFollowUpAssigned);
  safeOn("strike.created", onStrike);
}

module.exports = { register, onBooked, onCancelled, onMaterial, onTaskCreated, onTaskDone, onTargetsSet, onContract, onAssigned, onFollowUpAssigned, onStrike, followUpText, followUpButton, FOLLOW_UP_MESSAGE_INCLUDE, taskText, taskButton, TASK_INCLUDE };
