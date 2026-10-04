const prisma = require("../lib/prisma");
const { phoneKey } = require("../lib/phone");
const { clientIndexFor } = require("../lib/clientAccess");

// Reminders (src/routes/reminders.js): someone's own, or ones the boss or
// developer set for them, and "Remind me" on a call coming in (the caller's
// number, to call back). At the time, the person gets it in the Ledger app
// and on Telegram (sendDue, every minute with the other notifications).

const PERSON = { select: { id: true, username: true, name: true, role: true, employee: { select: { name: true } } } };
const REMINDER_INCLUDE = {
  user: PERSON,
  createdBy: PERSON,
  client: { select: { id: true, name: true } },
};
const personName = (u) => (u ? u.employee?.name || u.name || u.username : null);

// A reminder that's late by more than this when Ledger first sees it (the
// server was off) isn't sent any more — just marked.
const STALE_MS = 12 * 60 * 60 * 1000;

function publicReminder(r, { clientVisible = true } = {}) {
  const who = (u) => (u ? { id: u.id, name: personName(u), role: u.role } : null);
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    dueAt: r.dueAt,
    phone: r.phone,
    client: clientVisible ? r.client : null,
    user: who(r.user),
    createdBy: who(r.createdBy),
    sentAt: r.sentAt,
    doneAt: r.doneAt,
    createdAt: r.createdAt,
  };
}

// "Remind me" on a call coming in: call this number back in `minutes`. The
// title is the client's name when this person may see that client.
async function callBackReminder(user, { phone, name, minutes, dueAt }) {
  const when = dueAt ? new Date(dueAt) : new Date(Date.now() + Math.round(minutes) * 60 * 1000);
  const key = phoneKey(phone);
  const client = key ? (await clientIndexFor(user, [key])).get(key) : null;
  const known = client && !client.restricted ? client : null;
  const label = known?.name || (typeof name === "string" && name.trim()) || phone;
  return prisma.reminder.create({
    data: {
      userId: user.id,
      createdById: user.id,
      title: `Qayta qoʻngʻiroq: ${label}`.slice(0, 200),
      dueAt: when,
      phone: String(phone).slice(0, 40),
      clientId: known?.id ?? null,
    },
    include: REMINDER_INCLUDE,
  });
}

// The message (Telegram HTML; the app shows the same, services/notify.js).
function reminderText(r, f) {
  const lines = [
    `⏰ <b>${f.escapeHtml(r.title)}</b>`,
    r.notes ? f.escapeHtml(r.notes) : null,
    r.client ? `Mijoz: ${f.escapeHtml(r.client.name)}` : null,
    r.phone ? `Raqam: ${f.escapeHtml(f.phoneCompact(r.phone))}` : null,
    r.createdById && r.createdById !== r.userId && r.createdBy ? `Eslatma qoʻydi: ${f.escapeHtml(personName(r.createdBy))}` : null,
    f.portalLink("/reminders", "Eslatmalarni ochish"),
  ];
  return lines.filter(Boolean).join("\n");
}

// Every minute: the reminders whose time has come, each once.
async function sendDue() {
  const { notifyUser } = require("./telegram/notify");
  const f = require("./telegram/format");
  const due = await prisma.reminder.findMany({
    where: { doneAt: null, sentAt: null, dueAt: { lte: new Date() } },
    include: REMINDER_INCLUDE,
    orderBy: { dueAt: "asc" },
    take: 200,
  });
  for (const r of due) {
    // Claimed first: two checks overlapping never send it twice.
    const claimed = await prisma.reminder.updateMany({ where: { id: r.id, sentAt: null }, data: { sentAt: new Date() } });
    if (claimed.count !== 1) continue;
    if (Date.now() - r.dueAt.getTime() > STALE_MS) continue;
    // A client the person may no longer see isn't named.
    const visible = r.clientId ? await canSee(r.userId, r.clientId) : true;
    const shown = visible ? r : { ...r, client: null };
    await notifyUser(r.userId, null, reminderText(shown, f), undefined, { appExtra: { kind: "reminder", phone: r.phone, tag: `reminder:${r.id}` } });
  }
}

async function canSee(userId, clientId) {
  const { canAccessClient } = require("../lib/clientAccess");
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { employee: true } });
  return Boolean(user) && (await canAccessClient(user, clientId));
}

module.exports = { REMINDER_INCLUDE, publicReminder, callBackReminder, reminderText, sendDue, personName, STALE_MS };
