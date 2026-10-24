const prisma = require("../../lib/prisma");
const { phoneKey } = require("../../lib/phone");
const { callerLabel } = require("./caller");

// Who takes a client's call first (the firm's rule, 2026-10-24): a client the
// firm already works with — a case with a contract — doesn't go to the
// operators but straight to the coordinator of that case. Asterisk asks
// (hooks.js, [company-line]) when the call comes in:
//
//   POST /pbx/route  s=<secret>&num=<number>
//        -> "<phone ID>|<coordinator's name>", or "" (the call-center line)
//
// The coordinator's phone is woken if it's asleep; no answer in 25 s and the
// call goes to the call-center line, whose phones say who didn't answer.

const CONTRACT = "contract";

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
  const phone = await prisma.clientPhone.findFirst({ where: { phoneKey: key, client: { archivedAt: null } }, orderBy: { id: "asc" }, select: { client: CLIENT } });
  const contact = phone ? null : await prisma.clientContact.findFirst({ where: { phoneKey: key, deletedAt: null, client: { archivedAt: null } }, orderBy: { id: "asc" }, select: { client: CLIENT } });
  const client = (phone || contact)?.client;
  if (!client) return "";
  const ids = client.cases.map((k) => k.coordinator?.id).filter(Boolean);
  if (!ids.length) return "";
  const rows = await prisma.pbxExtension.findMany({ where: { employeeId: { in: ids }, ha1Enc: { not: null } }, select: { employeeId: true, ext: true } });
  const found = coordinatorFor(client, new Map(rows.map((r) => [r.employeeId, r.ext])));
  return found ? `${found.ext}|${callerLabel(found.name)}` : "";
}

module.exports = { route, coordinatorFor };
