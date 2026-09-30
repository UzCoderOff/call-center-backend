const prisma = require("./prisma");
const { isManager, isLawyer } = require("../middleware/auth");

// Who may see which client. The firm's rule (2026-09-30): the developer and
// the head of the firm see every client; a lawyer sees the clients with a
// case assigned to them; a staff member sees the clients they are the
// operator of (on any of the client's cases), or added themselves while no
// operator is assigned yet. Nobody else — not other operators, not office
// staff.
//
// Everything that shows client details goes through here: the clients list
// and page, calls ("this number is client X"), the calendar (someone else's
// booking is just "busy"), lookups by phone, and the Telegram summaries.

// A Prisma `where` for the clients this person may see ({} = all).
function clientScope(user) {
  if (isManager(user)) return {};
  if (isLawyer(user)) return { cases: { some: { lawyerId: user.id } } };
  const employeeId = user.employee?.id;
  if (!employeeId) return { id: -1 };
  return {
    OR: [
      { cases: { some: { operatorId: employeeId } } },
      // Added it, and nobody is its operator yet (once someone is, it's theirs).
      { createdById: user.id, cases: { none: { operatorId: { not: null } } } },
    ],
  };
}

// Their own cases, for case-level filters ({} = all).
function ownCaseWhere(user) {
  if (isManager(user)) return {};
  if (isLawyer(user)) return { lawyerId: user.id };
  return { operatorId: user.employee?.id ?? -1 };
}

async function canAccessClient(user, clientId, db = prisma) {
  if (isManager(user)) return true;
  if (!clientId) return false;
  return (await db.client.count({ where: { AND: [{ id: clientId }, clientScope(user)] } })) > 0;
}

// Of these client ids, the ones this person may see.
async function accessibleClientIds(user, ids, db = prisma) {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return new Set();
  if (isManager(user)) return new Set(wanted);
  const rows = await db.client.findMany({ where: { AND: [{ id: { in: wanted } }, clientScope(user)] }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

function notFound() {
  const err = new Error("not_found");
  err.status = 404;
  throw err;
}

// Throws a 404 unless the person may see the client (a client they may not
// see is "not found" — its existence isn't confirmed either).
async function requireClientAccess(user, clientId, db = prisma) {
  if (!(await canAccessClient(user, clientId, db))) notFound();
}

// A client someone may not open, as far as they may know it: that the number
// belongs to someone else's client, and whose — so they don't add a
// duplicate and know whom to ask.
function restricted(client) {
  const operators = [...new Set((client.cases || []).map((k) => k.operator?.name).filter(Boolean))];
  return { id: null, name: null, restricted: true, operator: operators.join(", ") || null };
}

// phoneKey -> the client behind that number: { id, name } when this person
// may see it, `restricted(...)` when not.
async function clientIndexFor(user, keys, db = prisma) {
  const wanted = [...new Set(keys.filter(Boolean))];
  const index = new Map();
  if (wanted.length === 0) return index;
  const rows = await db.clientPhone.findMany({
    where: { phoneKey: { in: wanted } },
    orderBy: { id: "asc" },
    select: { phoneKey: true, client: { select: { id: true, name: true, cases: { select: { operator: { select: { name: true } } } } } } },
  });
  const allowed = await accessibleClientIds(user, rows.map((r) => r.client.id), db);
  for (const row of rows) {
    if (index.has(row.phoneKey) && !index.get(row.phoneKey).restricted) continue;
    index.set(row.phoneKey, allowed.has(row.client.id) ? { id: row.client.id, name: row.client.name } : restricted(row.client));
  }
  return index;
}

module.exports = { clientScope, ownCaseWhere, canAccessClient, accessibleClientIds, requireClientAccess, restricted, clientIndexFor };
