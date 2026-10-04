const prisma = require("../lib/prisma");
const { getSetting, setSetting } = require("../lib/settings");
const { phoneKey } = require("../lib/phone");
const { firmDate } = require("../lib/firmTime");

// Consultations that went nowhere leave the lists by themselves (2026-10-03):
// a client with no contract who has had nothing happen for `days` days is
// archived — hidden from the lists, kept with everything about them,
// restorable (Mijozlar → Arxiv), and booked again they come back by
// themselves (lib/clientsDb.js).
//
// "Nothing happened" goes by the client's real dates, not the day they were
// entered into Ledger (old consultations were typed in and imported long
// after they happened): their consultation, notes and status changes, calls
// with their number, appointments, payments, follow-ups. Only a client with
// none of those counts from the day they were entered (unless imported).
//
// Never archived: anyone with an appointment ahead or a call planned ahead,
// anyone kept on purpose ("Arxivga tushmasin": Client.keepUntil), and any
// client with a contract (they're the coordinators' work).
//
// Setting "clientArchive": { enabled, days }. Runs every hour; harmless to
// repeat.

const ARCHIVE_DEFAULTS = { enabled: true, days: 14 };
const CONTRACT_STATUSES = ["contract", "done"];
const DAY_MS = 24 * 60 * 60 * 1000;

const archiveRules = (db) => getSetting("clientArchive", ARCHIVE_DEFAULTS, db);

async function saveArchiveRules(patch, userId, db) {
  const current = await archiveRules(db);
  return setSetting("clientArchive", { ...current, ...patch }, userId, db);
}

// A "YYYY-MM-DD" firm date as a moment (midday, so the timezone can't move it
// to another day).
const dateMs = (d) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00Z`).getTime() : null);

// Pure: the last time anything real happened with this client (ms), or null.
//   client: { createdAt, nextCallAt, cases: [{ startDate, consultationDate }],
//             events: [{ kind, createdAt, deletedAt }],
//             appointments: [{ date, status }], payments: [{ date }],
//             followUps: [{ createdAt, doneAt }], phones: [{ phone }] }
//   lastCallByKey: Map<phoneKey, ms>
function lastActivity(client, lastCallByKey = new Map()) {
  const real = [
    ...(client.cases || []).flatMap((k) => [dateMs(k.startDate), dateMs(k.consultationDate)]),
    ...(client.events || []).filter((e) => (e.kind === "note" || e.kind === "status") && !e.deletedAt).map((e) => new Date(e.createdAt).getTime()),
    ...(client.appointments || []).filter((a) => a.status !== "cancelled").map((a) => dateMs(a.date)),
    ...(client.payments || []).map((p) => dateMs(p.date)),
    ...(client.followUps || []).flatMap((f) => [f.createdAt && new Date(f.createdAt).getTime(), f.doneAt && new Date(f.doneAt).getTime()]),
    ...(client.phones || []).map((p) => lastCallByKey.get(phoneKey(p.phone)) ?? null),
    client.nextCallAt ? new Date(client.nextCallAt).getTime() : null,
  ].filter((t) => Number.isFinite(t) && t > 0);
  if (real.length) return Math.max(...real);
  const imported = (client.events || []).some((e) => e.kind === "import");
  return imported || !client.createdAt ? null : new Date(client.createdAt).getTime();
}

// Pure: whether this client goes to the archive now.
function isDue(client, { now, days, today, lastCallByKey }) {
  if (client.archivedAt) return false;
  if ((client.cases || []).some((k) => CONTRACT_STATUSES.includes(k.status))) return false;
  if (client.keepUntil && new Date(client.keepUntil).getTime() > now) return false;
  if (client.nextCallAt && new Date(client.nextCallAt).getTime() >= now) return false;
  if ((client.appointments || []).some((a) => a.status === "booked" && a.date >= today)) return false;
  const last = lastActivity(client, lastCallByKey);
  return last == null || last < now - days * DAY_MS;
}

const CANDIDATE_SELECT = {
  id: true,
  createdAt: true,
  archivedAt: true,
  keepUntil: true,
  nextCallAt: true,
  phones: { select: { phone: true } },
  cases: { select: { status: true, startDate: true, consultationDate: true } },
  events: { select: { kind: true, createdAt: true, deletedAt: true } },
  appointments: { select: { date: true, status: true } },
  payments: { select: { date: true } },
  followUps: { select: { createdAt: true, doneAt: true } },
};

// Archives every client that's due; returns how many.
async function archiveQuietClients({ now = Date.now(), db = prisma } = {}) {
  const rules = await archiveRules(db);
  if (!rules.enabled) return 0;
  const days = Math.max(1, Number(rules.days) || ARCHIVE_DEFAULTS.days);
  const clients = await db.client.findMany({
    where: { archivedAt: null, cases: { none: { status: { in: CONTRACT_STATUSES } } } },
    select: CANDIDATE_SELECT,
  });
  if (!clients.length) return 0;

  const keys = [...new Set(clients.flatMap((c) => c.phones.map((p) => phoneKey(p.phone))).filter(Boolean))];
  const calls = keys.length ? await db.callLog.groupBy({ by: ["phoneKey"], where: { phoneKey: { in: keys } }, _max: { callTimestampMs: true } }) : [];
  const lastCallByKey = new Map(calls.map((c) => [c.phoneKey, Number(c._max.callTimestampMs)]));
  const today = firmDate(new Date(now));
  const due = clients.filter((c) => isDue(c, { now, days, today, lastCallByKey }));

  let archived = 0;
  for (const c of due) {
    await db.$transaction(async (tx) => {
      // Only if nothing archived it meanwhile (a second run at the same time).
      const { count } = await tx.client.updateMany({ where: { id: c.id, archivedAt: null }, data: { archivedAt: new Date(now) } });
      if (!count) return;
      await tx.clientEvent.create({ data: { clientId: c.id, kind: "archive", text: "auto", data: { auto: true, days } } });
      await tx.auditLog.create({ data: { userId: null, action: "client.autoArchive", entity: "client", entityId: c.id, detail: { days } } });
      archived += 1;
    });
  }
  return archived;
}

module.exports = { ARCHIVE_DEFAULTS, archiveRules, saveArchiveRules, lastActivity, isDue, archiveQuietClients };
