const prisma = require("../../lib/prisma");
const { phoneKey } = require("../../lib/phone");
const { callerLabel } = require("./caller");

// Who takes a call first (the firm's rule, 2026-10-24), in this order:
//   1. a client the firm already works with — a case with a contract: the
//      coordinator of that case, not the operators;
//   2. a lost caller handed to another operator for a second try: that
//      operator (services/callOutcomes.js);
//   3. a caller who's thinking it over: the operator they talked to;
//   4. a caller someone on the line has talked to before (2026-10-27: "whoever
//      picks up a client's call, their next call goes straight to them"): the
//      last of them who had a real conversation with the number — answered
//      it, or reached it calling out;
//   5. everyone else: the call-center line, whoever's turn it is.
// Asterisk asks (hooks.js, [company-line]) when the call comes in:
//
//   POST /pbx/route  s=<secret>&num=<number>
//        -> "<phone ID>|<name>|<coordinator | second | thinking | last>", or "" (the line)
//
// That phone is woken if it's asleep; no answer in 30 s and the call goes to
// the call-center line, whose phones say whose caller it was and that they
// didn't answer — and that person is reminded to call back (ingest.js).

const CONTRACT = "contract";
const { ownerFor } = require("../callOutcomes");

// The coordinator of the client's newest case in work, who's on the line:
// { ext, name } or null. Pure: `client` with cases (status, updatedAt,
// coordinator { id, name, active, pbxCalling }), `lines` Map employeeId -> ext
// (phone IDs that can sign in).
function coordinatorFor(client, lines) {
  const cases = (client?.cases || []).filter((k) => k.status === CONTRACT && k.coordinator).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  for (const k of cases) {
    const c = k.coordinator;
    if (!c.active || !c.pbxCalling) continue;
    const ext = lines.get(c.id);
    if (ext) return { ext, name: c.name };
  }
  return null;
}

const CLIENT = {
  select: {
    archivedAt: true,
    cases: { select: { status: true, updatedAt: true, coordinator: { select: { id: true, name: true, active: true, pbxCalling: true } } } },
  },
};

async function route({ num }) {
  const key = phoneKey(num);
  if (!key) return "";
  return (await coordinatorRoute(key)) || (await ownerRoute(key)) || (await lastTalkedRoute(key)) || "";
}

// Phone IDs that can be rung now: signed up, the person on the line, and
// their phone not resting after failing to come up (presence.js).
const ringable = (now = new Date()) => ({
  ha1Enc: { not: null },
  employee: { active: true, pbxCalling: true },
  OR: [{ restingUntil: null }, { restingUntil: { lt: now } }],
});

// The last person on the line who talked to this number (a call that
// connected, either way): "<ext>|<name>|last", or null. Someone off the line
// now is passed over for the one before them.
async function lastTalkedRoute(key) {
  const calls = await prisma.callLog.findMany({
    where: { phoneKey: key, missed: false, durationSeconds: { gt: 0 } },
    orderBy: { callTimestampMs: "desc" },
    select: { employeeId: true },
    take: 20,
  });
  const ids = [...new Set(calls.map((c) => c.employeeId))];
  if (!ids.length) return null;
  const lines = await prisma.pbxExtension.findMany({ where: { employeeId: { in: ids }, ...ringable() }, select: { employeeId: true, ext: true, employee: { select: { name: true } } } });
  const byId = new Map(lines.map((l) => [l.employeeId, l]));
  const line = ids.map((id) => byId.get(id)).find(Boolean);
  return line ? `${line.ext}|${callerLabel(line.employee.name)}|last` : null;
}

// The operator a caller belongs to (second chance, thinking), on the line.
async function ownerRoute(key) {
  const owner = await ownerFor(key);
  if (!owner) return null;
  const line = await prisma.pbxExtension.findFirst({
    where: { employeeId: owner.employeeId, ha1Enc: { not: null }, employee: { active: true, pbxCalling: true } },
    select: { ext: true, employee: { select: { name: true } } },
  });
  return line ? `${line.ext}|${callerLabel(line.employee.name)}|${owner.kind}` : null;
}

async function coordinatorRoute(key) {
  const phone = await prisma.clientPhone.findFirst({ where: { phoneKey: key, client: { archivedAt: null } }, orderBy: { id: "asc" }, select: { client: CLIENT } });
  const contact = phone ? null : await prisma.clientContact.findFirst({ where: { phoneKey: key, deletedAt: null, client: { archivedAt: null } }, orderBy: { id: "asc" }, select: { client: CLIENT } });
  const client = (phone || contact)?.client;
  if (!client) return null;
  const ids = client.cases.map((k) => k.coordinator?.id).filter(Boolean);
  if (!ids.length) return null;
  const rows = await prisma.pbxExtension.findMany({ where: { employeeId: { in: ids }, ha1Enc: { not: null } }, select: { employeeId: true, ext: true } });
  const found = coordinatorFor(client, new Map(rows.map((r) => [r.employeeId, r.ext])));
  return found ? `${found.ext}|${callerLabel(found.name)}|coordinator` : null;
}

module.exports = { route, coordinatorFor, lastTalkedRoute };
