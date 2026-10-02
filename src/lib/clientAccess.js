const prisma = require("./prisma");
const { isManager, isLawyer } = require("../middleware/auth");

// Who may see which client, and how much of it. The firm's rules
// (2026-09-30, extended 2026-10-02 — a case changes hands at the contract):
//
//   managers (developer, head of the firm)  everything
//   lawyer       the cases assigned to them — all of each case (money only
//                with the Moliya switch, src/lib/finance.js)
//   coordinator  the cases assigned to them after the contract — all of each
//                case, its money too: payments, schedule, what's overdue
//   operator     (call center) their clients while it's a consultation —
//                as before. Once the client signs, the case is the
//                coordinator's: the operator keeps a "result" view of it —
//                name, number and the dates (consultation, contract), their
//                own calls — and no longer the case, its stage or money.
//
// Each case gets a role for the viewer (caseRole); the client as a whole
// gets the strongest of them (clientLevel). Everything that shows client
// details goes through here: the clients list and page, calls ("this number
// is client X"), the calendar (someone else's booking is just "busy"),
// lookups by phone, and the Telegram summaries.

// A case past this point belongs to the coordinator and lawyer.
const CONTRACT_STATUSES = ["contract", "done"];
const isContractPhase = (status) => CONTRACT_STATUSES.includes(status);

// Strongest first: what the client page shows when someone has several roles
// on one client's cases.
const LEVELS = ["manager", "coordinator", "lawyer", "operator", "result"];

const employeeIdOf = (user) => user?.employee?.id ?? null;

// A Prisma `where` for the clients this person may open ({} = all) —
// including the ones they only see as a result.
function clientScope(user) {
  if (isManager(user)) return {};
  if (isLawyer(user)) return { cases: { some: { lawyerId: user.id } } };
  const me = employeeIdOf(user);
  if (!me) return { id: -1 };
  return {
    OR: [
      { cases: { some: { operatorId: me } } },
      { cases: { some: { coordinatorId: me } } },
      // Added it, and nobody is its operator yet (once someone is, it's theirs).
      { createdById: user.id, cases: { none: { operatorId: { not: null } } } },
    ],
  };
}

// The clients this person works on now (call lists, "call today", their
// client list) — not the ones they only see as a past result.
function workScope(user) {
  if (isManager(user)) return {};
  if (isLawyer(user)) return { cases: { some: { lawyerId: user.id } } };
  const me = employeeIdOf(user);
  if (!me) return { id: -1 };
  return {
    OR: [
      { cases: { some: { operatorId: me, status: { notIn: CONTRACT_STATUSES } } } },
      { cases: { some: { coordinatorId: me } } },
      { createdById: user.id, cases: { none: { operatorId: { not: null } } } },
    ],
  };
}

// Their own cases, for case-level filters ({} = all).
function ownCaseWhere(user) {
  if (isManager(user)) return {};
  if (isLawyer(user)) return { lawyerId: user.id };
  const me = employeeIdOf(user) ?? -1;
  return { OR: [{ operatorId: me }, { coordinatorId: me }] };
}

// This person's role on one case: "manager" | "lawyer" | "coordinator" |
// "operator" | "result" | null. `kase` needs status, operatorId,
// coordinatorId, lawyerId; `client` (createdById, and whether any of its
// cases has an operator) for the "added it, nobody's operator yet" rule.
function caseRole(user, kase, client = null) {
  if (isManager(user)) return "manager";
  if (isLawyer(user)) return kase.lawyerId === user.id ? "lawyer" : null;
  const me = employeeIdOf(user);
  if (!me) return null;
  if (kase.coordinatorId === me) return "coordinator";
  const creator = client && client.createdById === user.id && !(client.cases || []).some((k) => k.operatorId != null);
  if (kase.operatorId === me || (kase.operatorId == null && creator)) return isContractPhase(kase.status) ? "result" : "operator";
  return null;
}

// The client as a whole for this person: { level, roles: Map caseId -> role }.
// level null: they may not see it at all. A client with no cases yet: its
// creator works on it.
function clientLevel(user, client) {
  const roles = new Map();
  if (isManager(user)) {
    for (const k of client.cases || []) roles.set(k.id, "manager");
    return { level: "manager", roles };
  }
  for (const k of client.cases || []) {
    const role = caseRole(user, k, client);
    if (role) roles.set(k.id, role);
  }
  let level = LEVELS.find((l) => [...roles.values()].includes(l)) || null;
  if (!level && !isLawyer(user) && client.createdById === user.id && !(client.cases || []).some((k) => k.operatorId != null)) level = "operator";
  return { level, roles };
}

const ACCESS_SELECT = { id: true, createdById: true, archivedAt: true, cases: { select: { id: true, status: true, operatorId: true, coordinatorId: true, lawyerId: true } } };

function notFound() {
  const err = new Error("not_found");
  err.status = 404;
  throw err;
}

// { client, level, roles } — or a 404 when the client doesn't exist or the
// person may not see it (its existence isn't confirmed either).
async function loadAccess(user, clientId, db = prisma) {
  const client = clientId ? await db.client.findUnique({ where: { id: clientId }, select: ACCESS_SELECT }) : null;
  if (!client) notFound();
  const { level, roles } = clientLevel(user, client);
  if (!level) notFound();
  return { client, level, roles };
}

// Throws unless the person may see the client. `write`: they also want to
// change it (details, notes, connections) — not for someone who only sees a
// past result (403 "result_only").
async function requireClientAccess(user, clientId, { write = false, db = prisma } = {}) {
  const access = await loadAccess(user, clientId, db);
  if (write && access.level === "result") {
    const err = new Error("result_only");
    err.status = 403;
    throw err;
  }
  return access;
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

// A client someone may not open, as far as they may know it: that the number
// belongs to someone else's client, and whose — the coordinator once there's
// a contract, else the operator — so they don't add a duplicate and know whom
// to ask.
function restricted(client) {
  const names = (pick) => [...new Set((client.cases || []).map(pick).filter(Boolean))];
  const coordinators = names((k) => k.coordinator?.name);
  const operators = names((k) => k.operator?.name);
  return { id: null, name: null, restricted: true, operator: operators.join(", ") || null, coordinator: coordinators.join(", ") || null };
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
    select: { phoneKey: true, client: { select: { id: true, name: true, cases: { select: { operator: { select: { name: true } }, coordinator: { select: { name: true } } } } } } },
  });
  // Numbers that aren't a client's own but someone connected to a client
  // (their father, a representative…): that client, and who it is.
  const found = new Set(rows.map((r) => r.phoneKey));
  const viaContacts = await db.clientContact.findMany({
    where: { phoneKey: { in: wanted.filter((k) => !found.has(k)) }, deletedAt: null },
    orderBy: { id: "asc" },
    select: { phoneKey: true, name: true, relation: true, client: { select: { id: true, name: true, cases: { select: { operator: { select: { name: true } }, coordinator: { select: { name: true } } } } } } },
  });
  const allowed = await accessibleClientIds(user, [...rows.map((r) => r.client.id), ...viaContacts.map((r) => r.client.id)], db);
  for (const row of rows) {
    if (index.has(row.phoneKey) && !index.get(row.phoneKey).restricted) continue;
    index.set(row.phoneKey, allowed.has(row.client.id) ? { id: row.client.id, name: row.client.name } : restricted(row.client));
  }
  for (const row of viaContacts) {
    if (index.has(row.phoneKey) && !index.get(row.phoneKey).restricted) continue;
    index.set(row.phoneKey, allowed.has(row.client.id) ? { id: row.client.id, name: row.client.name, contact: { name: row.name, relation: row.relation } } : restricted(row.client));
  }
  return index;
}

module.exports = {
  CONTRACT_STATUSES,
  isContractPhase,
  clientScope,
  workScope,
  ownCaseWhere,
  caseRole,
  clientLevel,
  loadAccess,
  canAccessClient,
  accessibleClientIds,
  requireClientAccess,
  restricted,
  clientIndexFor,
};
