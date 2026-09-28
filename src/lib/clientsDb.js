const { phoneKey } = require("./phone");
const cl = require("../services/clients");
const { lawyerById } = require("./lawyers");

// Clients-database helpers that touch the database — shared by the clients
// routes, the calls list (names instead of bare numbers) and the calendar
// (a booking finds or creates its client). `db` is prisma or a transaction.

// Rebuilds the text a client is found by (name, city, phones, case numbers).
async function refreshSearch(db, clientId) {
  const c = await db.client.findUnique({
    where: { id: clientId },
    select: { name: true, city: true, phones: { select: { phone: true } }, cases: { select: { number: true } } },
  });
  if (!c) return;
  const searchText = cl.buildSearchText({
    name: c.name,
    city: c.city,
    phones: c.phones.map((p) => p.phone),
    caseNumbers: c.cases.map((k) => k.number).filter(Boolean),
  });
  await db.client.update({ where: { id: clientId }, data: { searchText } });
}

// Clients with any of these phone keys, as { id, name } — for "this number
// already belongs to …" and for the calls list.
async function clientsByPhoneKeys(db, keys, { exceptId } = {}) {
  const wanted = [...new Set(keys.filter(Boolean))];
  if (wanted.length === 0) return [];
  const rows = await db.clientPhone.findMany({
    where: { phoneKey: { in: wanted }, ...(exceptId ? { clientId: { not: exceptId } } : {}) },
    select: { phoneKey: true, client: { select: { id: true, name: true } } },
    orderBy: { id: "asc" },
  });
  return rows;
}

// phoneKey -> { id, name } (the first client with that number).
async function clientIndex(db, keys) {
  const index = new Map();
  for (const row of await clientsByPhoneKeys(db, keys)) {
    if (!index.has(row.phoneKey)) index.set(row.phoneKey, row.client);
  }
  return index;
}

// A booking made in the calendar belongs to a client: the one with that phone
// number, or a new one (with a consultation case, so it counts toward the
// booking operator's monthly target). The case goes to the lawyer whose
// calendar it is (lawyerId: the calendar's owner), so they see the client.
// Without a phone number there's nothing reliable to match on, so no client
// is created.
async function clientForBooking(db, { name, phone, matter, date, user, lawyerId = null }) {
  const key = phoneKey(phone);
  if (!key) return null;
  const operatorId = user.employee?.id ?? null;
  const lawyer = lawyerId ? await lawyerById(lawyerId, db) : null;
  const assigned = lawyer ? { lawyerId: lawyer.id, lawyer: lawyer.name } : {};
  const [existing] = await clientsByPhoneKeys(db, [key]);
  if (existing) {
    // Booked again: an archived client is active again.
    const current = await db.client.findUnique({ where: { id: existing.client.id }, select: { archivedAt: true } });
    if (current?.archivedAt) {
      await db.client.update({ where: { id: existing.client.id }, data: { archivedAt: null } });
      await db.clientEvent.create({ data: { clientId: existing.client.id, kind: "restore", text: "", authorId: user.id } });
    }
    const open = await db.clientCase.findFirst({
      where: { clientId: existing.client.id, status: { in: cl.OPEN_STATUSES } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, lawyerId: true },
    });
    if (!open) {
      await db.clientCase.create({
        data: { clientId: existing.client.id, matter: cl.text(matter, 500), operatorId, startDate: date, consultationDate: date, ...assigned },
      });
    } else if (!open.lawyerId && lawyer) {
      // Their open case had no lawyer yet: it's this one's now.
      await db.clientCase.update({ where: { id: open.id }, data: assigned });
    }
    return existing.client.id;
  }
  const client = await db.client.create({
    data: {
      name: cl.text(name, 160) || phone,
      source: "call",
      createdById: user.id,
      phones: { create: [{ phone: String(phone).trim().slice(0, 40), phoneKey: key }] },
      cases: { create: [{ matter: cl.text(matter, 500), operatorId, startDate: date, consultationDate: date, ...assigned }] },
    },
  });
  await refreshSearch(db, client.id);
  return client.id;
}

module.exports = { refreshSearch, clientsByPhoneKeys, clientIndex, clientForBooking };
