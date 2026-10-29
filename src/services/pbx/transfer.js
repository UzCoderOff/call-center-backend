const prisma = require("../../lib/prisma");
const state = require("./state");
const { phoneKey } = require("../../lib/phone");
const { hasJob } = require("../../lib/jobs");
const { accessibleClientIds } = require("../../lib/clientAccess");
const { searchable } = require("../clients");
const { callerLabel } = require("./caller");

// Passing a client's call on to a colleague — the call screen's "Ulash"
// (GET / POST /api/device/transfer). The usual case: a client calls the
// company line about their case, the operator can't see the case, so they
// pass the call to the client's coordinator without the client calling again.
//
// The client stays on the line: Ledger moves their side of the call to
// [ledger-transfer] (pbx/asterisk/extensions.conf), where they hear music
// while the colleague's phone rings (woken by push if it's asleep). Nobody
// answers in 30 s: it rings the person who passed it on again; still nobody:
// back in line for the call center. A colleague who didn't answer gets a
// reminder to call the client back (ingest.js).
//
// What an operator learns here about someone else's client is what the rest
// of Ledger already shows them (clientAccess.js restricted()): that the client
// exists and who works on them — no case, no status, no money. Found by a
// search, not even their name or number (else searching numbers would list
// the whole client base): just "Mijoz" and its people.

const ROLE = { coordinator: "Koordinator", lawyer: "Advokat", operator: "Operator" };
const SEARCH_MIN = 3;
const SEARCH_MAX = 8;

class TransferError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// ----------------------------------------------------------- the call itself

// Of Asterisk's channels (CoreShowChannels), the client's side of the call
// this phone ID is talking on — the channel that's in line, sent straight to
// its coordinator or being passed on (Queue or Dial in [company-line], Dial
// in [ledger-transfer]) and in the same
// call (Linkedid) as their phone, which is up. null: they're on no such call
// (a call out, a colleague, nothing).
function findClientLeg(channels, ext) {
  const mine = channels.filter((c) => String(c.Channel || "").startsWith(`PJSIP/${ext}-`) && c.ChannelState === "6" && c.BridgeId);
  for (const m of mine) {
    const leg = channels.find(
      (c) => c !== m && c.Linkedid === m.Linkedid && c.BridgeId && (c.Application === "Queue" || (["ledger-transfer", "company-line"].includes(c.Context) && c.Application === "Dial"))
    );
    if (leg) return leg;
  }
  return null;
}

async function extensionOf(employeeId) {
  return employeeId ? prisma.pbxExtension.findUnique({ where: { employeeId } }) : null;
}

// Moves this person's client call to `toEmployeeId`'s phone. -> { name } of
// who it went to. Errors (TransferError.code): pbx_off, no_phone_id,
// no_target, self, target_off, no_call.
async function transferCall(user, toEmployeeId) {
  const ami = state.ami;
  if (!state.enabled || !ami?.ready) throw new TransferError("pbx_off");
  const mine = await extensionOf(user.employee?.id);
  if (!mine) throw new TransferError("no_phone_id", 403);
  const target = await prisma.pbxExtension.findUnique({ where: { employeeId: Number(toEmployeeId) || -1 }, include: { employee: { select: { name: true, active: true, pbxCalling: true } } } });
  if (!target) throw new TransferError("no_target", 404);
  if (target.ext === mine.ext) throw new TransferError("self", 400);
  if (!target.employee.active || !target.employee.pbxCalling || !target.ha1Enc) throw new TransferError("target_off");

  const channels = (await ami.actionList({ Action: "CoreShowChannels" })).filter((e) => e.Event === "CoreShowChannel");
  const leg = findClientLeg(channels, mine.ext);
  if (!leg) throw new TransferError("no_call");

  const fromName = callerLabel(user.employee?.name) || mine.ext;
  const toName = callerLabel(target.employee.name) || target.ext;
  // Read by [ledger-transfer]: whom to ring back, and the names its phones show.
  for (const [Variable, Value] of [
    ["LEDGER_XFER_BACK", mine.ext],
    ["LEDGER_XFER_FROM_NAME", fromName],
    ["LEDGER_XFER_TO_NAME", toName],
  ]) {
    await ami.action({ Action: "Setvar", Channel: leg.Channel, Variable, Value });
  }
  const res = await ami.action({ Action: "Redirect", Channel: leg.Channel, Context: "ledger-transfer", Exten: target.ext, Priority: 1 });
  if (res.Response !== "Success") throw new TransferError("no_call");
  console.log(`[pbx] ${mine.ext} passed a client's call to ${target.ext}`);
  return { name: target.employee.name };
}

// ------------------------------------------------------------- whom to ring

// Phone ID -> "free" | "busy" | "off", from the busy/free hints
// (config.js renderHints: the phone, or the app that can be woken).
// ExtensionStateList Status: 0 idle, 1 in use, 2 busy, 4 unavailable,
// 8 ringing, 16 on hold (and sums of them).
function reachabilityOf(events) {
  const out = new Map();
  for (const e of events) {
    if (e.Event !== "ExtensionStatus" || e.Context !== "ledger-hints") continue;
    const status = Number(e.Status);
    out.set(e.Exten, status === 0 ? "free" : status === 4 || status < 0 ? "off" : "busy");
  }
  return out;
}

async function reachability() {
  const ami = state.ami;
  if (!state.enabled || !ami?.ready) return new Map();
  try {
    return reachabilityOf(await ami.actionList({ Action: "ExtensionStateList" }));
  } catch (err) {
    console.warn("[pbx] couldn't read who's free:", err.message);
    return new Map();
  }
}

// Everyone on the line but this person: { employeeId, name, ext, job, status }.
async function colleagues(user, status) {
  const rows = await prisma.pbxExtension.findMany({
    where: { ha1Enc: { not: null }, employee: { active: true, pbxCalling: true } },
    include: { employee: { select: { id: true, name: true, job: true, extraJobs: true, position: { select: { name: true } } } } },
    orderBy: { ext: "asc" },
  });
  return rows
    .filter((r) => r.employeeId !== user.employee?.id)
    .map((r) => ({
      employeeId: r.employeeId,
      name: r.employee.name,
      ext: r.ext,
      job: r.employee.position?.name || (hasJob(r.employee, "coordinator") ? ROLE.coordinator : hasJob(r.employee, "call_center") ? ROLE.operator : null),
      status: status.get(r.ext) || "off",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const CASE_PEOPLE = {
  status: true,
  operator: { select: { id: true, name: true } },
  coordinator: { select: { id: true, name: true } },
  lawyerAccount: { select: { employee: { select: { id: true, name: true } } } },
  extraLawyers: { select: { user: { select: { employee: { select: { id: true, name: true } } } } } },
};

// Who works on a client, most useful first: the coordinator(s) once there's
// a contract, the lawyers, then the operator of a case still before one.
// Only people who are on the line can take the call; the rest are listed so
// the person knows whom the client belongs to.
function peopleOf(client, byEmployee) {
  const seen = new Set();
  const out = [];
  const add = (employee, role) => {
    if (!employee || seen.has(employee.id)) return;
    seen.add(employee.id);
    const line = byEmployee.get(employee.id);
    out.push({ employeeId: employee.id, name: employee.name, role: ROLE[role], ext: line?.ext ?? null, status: line?.status ?? "off" });
  };
  const cases = client.cases || [];
  for (const k of cases) add(k.coordinator, "coordinator");
  for (const k of cases) {
    add(k.lawyerAccount?.employee, "lawyer");
    for (const l of k.extraLawyers || []) add(l.user?.employee, "lawyer");
  }
  for (const k of cases) if (!["contract", "done"].includes(k.status)) add(k.operator, "operator");
  return out;
}

// "+998 90 123 45 67" -> "•• 67": enough to tell two clients with one name apart.
const phoneTail = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 4 ? `•• ${digits.slice(-2)}` : null;
};

// A client a search found, as this person may know them: their own (or any,
// for managers) by name and the end of their number; someone else's only as
// "Mijoz" with the people who work on them, so the call can still go there.
// (The app shows `name` as it comes: null would read "null".)
const OTHERS_CLIENT = "Mijoz";
function foundClient(c, mayOpen, people) {
  if (!mayOpen) return { id: null, name: OTHERS_CLIENT, phone: null, restricted: true, people };
  return { id: c.id, name: c.name, phone: phoneTail(c.phones?.[0]?.phone), people };
}

// The transfer panel: { forCaller, clients, colleagues }.
//   number  the other side of the call: the people who work on that client
//   q       a client's name or number (3+ letters), or a colleague's name
async function transferTargets(user, { number, q } = {}) {
  // Only for people on the line: they're the ones with calls to pass on.
  if (!(await extensionOf(user.employee?.id)) || !user.employee?.pbxCalling) throw new TransferError("no_phone_id", 403);
  const status = await reachability();
  const all = await colleagues(user, status);
  const byEmployee = new Map(all.map((c) => [c.employeeId, c]));
  const me = user.employee?.id;
  const notMe = (list) => list.filter((p) => p.employeeId !== me);

  let forCaller = [];
  const key = phoneKey(number);
  if (key) {
    const phone = await prisma.clientPhone.findFirst({ where: { phoneKey: key, client: { archivedAt: null } }, orderBy: { id: "asc" }, select: { client: { select: { id: true, cases: { select: CASE_PEOPLE } } } } });
    const contact = phone ? null : await prisma.clientContact.findFirst({ where: { phoneKey: key, deletedAt: null, client: { archivedAt: null } }, orderBy: { id: "asc" }, select: { client: { select: { id: true, cases: { select: CASE_PEOPLE } } } } });
    const client = (phone || contact)?.client;
    if (client) forCaller = notMe(peopleOf(client, byEmployee));
  }

  const query = String(q || "").trim().slice(0, 60);
  const words = searchable(query).split(" ").filter(Boolean);
  let clients = [];
  if (searchable(query).replace(/\s/g, "").length >= SEARCH_MIN) {
    const rows = await prisma.client.findMany({
      where: { AND: [{ archivedAt: null }, ...words.map((w) => ({ searchText: { contains: w } }))] },
      orderBy: { updatedAt: "desc" },
      take: SEARCH_MAX,
      select: { id: true, name: true, phones: { orderBy: { id: "asc" }, take: 1, select: { phone: true } }, cases: { select: CASE_PEOPLE } },
    });
    const mayOpen = await accessibleClientIds(user, rows.map((c) => c.id));
    clients = rows.map((c) => foundClient(c, mayOpen.has(c.id), notMe(peopleOf(c, byEmployee)))).filter((c) => c.people.length > 0);
  }

  const people = words.length ? all.filter((c) => words.every((w) => searchable(c.name).includes(w))) : all;
  return { forCaller, clients, colleagues: people };
}

module.exports = { transferCall, transferTargets, findClientLeg, reachabilityOf, peopleOf, foundClient, TransferError };
