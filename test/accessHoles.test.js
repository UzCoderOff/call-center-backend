const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused-secret-for-tests";
const prisma = require("../src/lib/prisma");
const { transferTargets, foundClient } = require("../src/services/pbx/transfer");
const s = require("../src/services/consultSummary");

// The access holes closed on 2026-10-29, with a stand-in database (made-up
// people and clients): the call-transfer search, what a consultation's
// specialist sees and may change, and adding cases.

const operator = { id: 4, role: "EMPLOYEE", active: true, employee: { id: 7, name: "Dilnoza", job: "call_center", extraJobs: "", collectCalls: true, pbxCalling: true } };
const boss = { id: 2, role: "BOSS", active: true, employee: { id: 1, name: "Rahbar", job: "other", extraJobs: "", pbxCalling: true } };
const lawyer = { id: 3, role: "LAWYER", active: true, employee: null };

// ------------------------------------------------- the call-transfer search
const ours = {
  id: 1,
  name: "Karimov Aziz",
  phones: [{ phone: "+998 90 123 45 67" }],
  cases: [{ status: "consultation", operator: { id: 7, name: "Dilnoza" }, coordinator: null, lawyerAccount: { employee: { id: 9, name: "Advokat Test" } }, extraLawyers: [] }],
};
const someoneElses = {
  id: 2,
  name: "Karimova Nodira",
  phones: [{ phone: "+998 91 765 43 21" }],
  cases: [{ status: "contract", operator: { id: 5, name: "Boshqa operator" }, coordinator: { id: 8, name: "Aziza" }, lawyerAccount: null, extraLawyers: [] }],
};

function phoneLine(opens) {
  prisma.pbxExtension.findUnique = async ({ where }) => ({ employeeId: where.employeeId, ext: String(200 + where.employeeId) });
  prisma.pbxExtension.findMany = async () =>
    [7, 8, 9].map((id) => ({ employeeId: id, ext: String(200 + id), employee: { id, name: { 7: "Dilnoza", 8: "Aziza", 9: "Advokat Test" }[id], job: id === 8 ? "coordinator" : "other", extraJobs: "", position: null } }));
  // The search itself, then which of the found clients this person may open.
  prisma.client.findMany = async ({ where, select }) => (select.phones ? [ours, someoneElses] : where.AND[0].id.in.filter((id) => opens.includes(id)).map((id) => ({ id })));
}

test("the transfer search shows someone else's client without their name or number — only who works on them", async () => {
  phoneLine([1]);
  for (const q of ["karimov", "4321"]) {
    const { clients } = await transferTargets(operator, { number: "", q });
    assert.deepEqual(clients[0], { id: 1, name: "Karimov Aziz", phone: "•• 67", people: [{ employeeId: 9, name: "Advokat Test", role: "Advokat", ext: "209", status: "off" }] });
    assert.deepEqual(clients[1], { id: null, name: "Mijoz", phone: null, restricted: true, people: [{ employeeId: 8, name: "Aziza", role: "Koordinator", ext: "208", status: "off" }] });
    assert.ok(!JSON.stringify(clients).includes("Nodira"));
    assert.ok(!JSON.stringify(clients).includes("21"));
  }
});

test("managers find every client by name in the transfer search", async () => {
  phoneLine([]);
  const { clients } = await transferTargets(boss, { number: "", q: "karimov" });
  assert.deepEqual(
    clients.map((c) => [c.id, c.name, c.phone]),
    [
      [1, "Karimov Aziz", "•• 67"],
      [2, "Karimova Nodira", "•• 21"],
    ]
  );
  assert.equal(foundClient(someoneElses, false, []).name, "Mijoz");
});

// ------------------------------------------- the consultation's specialist
// The client: an open consultation with another lawyer (11), someone else's
// contract (12), and a finished case of the lawyer's own (13). Newest first.
const client = {
  createdById: 50,
  cases: [
    { id: 11, status: "consultation", operatorId: 7, coordinatorId: null, lawyerId: 9, extraLawyers: [] },
    { id: 12, status: "contract", operatorId: 6, coordinatorId: 8, lawyerId: 9, extraLawyers: [] },
    { id: 13, status: "done", operatorId: 6, coordinatorId: 8, lawyerId: 3, extraLawyers: [] },
  ],
};
const appointment = (over = {}) => ({ id: 30, date: "2026-10-28", status: "attended", summaryAt: null, clientId: 100, calendar: { ownerId: 3 }, bookedById: 3, caseId: null, ...over });
const byOperator = { role: "EMPLOYEE", employee: { id: 7 } };
const byLawyer = { role: "LAWYER", employee: null };
const ids = (set) => (set ? [...set].sort() : set);

test("a lawyer who booked a known number into their own calendar gets only the cases they work on anyway", () => {
  assert.deepEqual(ids(s.summaryCaseIds(lawyer, appointment(), client, byLawyer)), [13]);
  const notTheirs = { ...client, cases: client.cases.slice(0, 2) };
  assert.deepEqual(ids(s.summaryCaseIds(lawyer, appointment(), notTheirs, byLawyer)), []);
});

test("booked in by an operator: the lawyer gets the open consultation the booking joined, not the client's other cases", () => {
  assert.deepEqual(ids(s.summaryCaseIds(lawyer, appointment({ bookedById: 4 }), client, byOperator)), [11, 13]);
  // The client's coordinator booking a meeting only links it: no case comes with it.
  assert.deepEqual(ids(s.summaryCaseIds(lawyer, appointment({ bookedById: 6 }), client, { role: "EMPLOYEE", employee: { id: 8 } })), [13]);
  // The case a summary was already written for stays visible to its writer.
  assert.deepEqual(ids(s.summaryCaseIds(lawyer, appointment({ caseId: 12 }), client, byLawyer)), [12, 13]);
  // Managers: all of them.
  assert.equal(s.summaryCaseIds(boss, appointment(), client, byLawyer), null);
});

// saveSummary against a stand-in transaction: what it would write.
function summaryDb(a, booker) {
  const writes = { appointment: null, cases: [] };
  const matches = (k, where) =>
    where.clientId === a.clientId && (where.id == null || (typeof where.id === "number" ? k.id === where.id : where.id.in.includes(k.id))) && (!where.status || where.status.in.includes(k.status));
  const tx = {
    appointment: { findUnique: async () => a, update: async ({ data }) => (writes.appointment = data) },
    client: { findUnique: async () => client, update: async () => ({}) },
    user: { findUnique: async () => booker },
    clientCase: {
      findFirst: async ({ where }) => {
        const k = client.cases.find((c) => matches(c, where));
        return k ? { ...k, contractDate: null, consultationDate: "2026-10-28", closedDate: null, operator: { userId: 40, name: "Dilnoza" } } : null;
      },
      update: async ({ where, data }) => writes.cases.push({ id: where.id, ...data }),
    },
    clientContact: { findFirst: async () => ({ id: 5 }) },
    summaryStrike: { updateMany: async () => ({}) },
    clientEvent: { create: async () => ({}) },
  };
  return { db: { $transaction: (fn) => fn(tx) }, writes };
}
const signed = { conclusion: "Shartnoma tuzdi", prospect: "potential", next: { kind: "contract" } };

test("the lawyer can't write a summary onto someone else's case, or turn it into a contract", async () => {
  const { db, writes } = summaryDb(appointment(), byLawyer);
  await assert.rejects(s.saveSummary(db, { appointmentId: 30, user: lawyer, input: signed, caseId: 12 }), /not this client's/);
  await assert.rejects(s.saveSummary(db, { appointmentId: 30, user: lawyer, input: signed, caseId: 11 }), /not this client's/);
  assert.equal(writes.appointment, null);
  // Without picking one: their own case, never the open consultation of another lawyer.
  const out = await s.saveSummary(db, { appointmentId: 30, user: lawyer, input: signed });
  assert.equal(out.caseId, 13);
  assert.deepEqual(writes.cases, []);
});

test("a lawyer with no case of the client's writes the summary on the client alone, and names none of its people", async () => {
  const before = client.cases;
  client.cases = before.slice(0, 2);
  try {
    const { db, writes } = summaryDb(appointment(), byLawyer);
    const call = { conclusion: "Oʻylab koʻradi", prospect: "not_potential", lostReason: "price" };
    const out = await s.saveSummary(db, { appointmentId: 30, user: lawyer, input: call });
    assert.equal(out.caseId, null);
    assert.equal(writes.appointment.caseId, null);
    assert.deepEqual(writes.cases, [], "the open consultation of another lawyer isn't declined");
    const withContact = { conclusion: "x", prospect: "potential", next: { kind: "call", dueAt: new Date(Date.now() + 86400000).toISOString(), contactId: 5 } };
    await assert.rejects(s.saveSummary(summaryDb(appointment(), byLawyer).db, { appointmentId: 30, user: lawyer, input: withContact }), /contact is not this client's/);
  } finally {
    client.cases = before;
  }
});

test("booked in by an operator, the lawyer's summary still makes that consultation a contract", async () => {
  const { db, writes } = summaryDb(appointment({ bookedById: 4 }), byOperator);
  const out = await s.saveSummary(db, { appointmentId: 30, user: lawyer, input: signed });
  assert.equal(out.caseId, 11);
  assert.equal(writes.cases[0].id, 11);
  assert.equal(writes.cases[0].status, "contract");
});

test("managers may write the summary onto any of the client's cases", async () => {
  const { db, writes } = summaryDb(appointment(), byLawyer);
  const out = await s.saveSummary(db, { appointmentId: 30, user: boss, input: signed, caseId: 11 });
  assert.equal(out.caseId, 11);
  assert.equal(writes.cases[0].status, "contract");
});

// ---------------------------------------------------------- adding cases
// Through the real routes (src/app.js), signed in with a session cookie.
const app = require("../src/app");
const { signSessionToken } = require("../src/lib/tokens");

async function call(user, method, path, body, people = {}) {
  prisma.user.findUnique = async ({ where }) => (where.id === user.id ? user : (people[where.id] ?? null));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const log = console.log;
  console.log = () => {};
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { "content-type": "application/json", cookie: `session=${signSessionToken(user)}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    console.log = log;
    server.close();
  }
}

// Client 1, whose case 10 is the operator's: a consultation, or signed.
function clientWithCase(status) {
  const created = [];
  const row = { id: 1, name: "Test Mijoz", city: null, archivedAt: null, createdById: 99, phones: [], cases: [{ id: 10, status, operatorId: 7, coordinatorId: status === "contract" ? 8 : null, lawyerId: null, extraLawyers: [] }] };
  prisma.client.findUnique = async () => row;
  prisma.client.update = async () => row;
  prisma.client.create = async ({ data }) => (created.push(data), { id: 1, ...data });
  prisma.clientCase.create = async ({ data }) => (created.push(data), { id: 20, ...data });
  prisma.clientEvent.create = async () => ({});
  prisma.$transaction = async (fn) => fn(prisma);
  return created;
}

test("an operator who only sees a past result can't add a case to that client", async () => {
  const created = clientWithCase("contract");
  const res = await call(operator, "POST", "/api/clients/1/cases", { matter: "Meros", status: "consultation" });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "result_only");
  assert.deepEqual(created, []);
});

test("a new case takes only what its operator may set: no finished case, no contract date of their own", async () => {
  const created = clientWithCase("consultation");
  for (const body of [{ matter: "Meros", status: "done" }, { matter: "Meros", status: "contract", contractDate: "2026-09-15" }, { matter: "Meros", court: "Yunusobod" }]) {
    const res = await call(operator, "POST", "/api/clients/1/cases", body);
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.equal(res.body.error, "forbidden");
  }
  assert.deepEqual(created, []);
  const ok = await call(operator, "POST", "/api/clients/1/cases", { matter: "Meros", status: "consultation" });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.operatorId, 7);
  assert.equal(ok.body.status, "consultation");
});

test("a new client's first case: the same limits for staff, none for managers", async () => {
  const created = clientWithCase("consultation");
  const staff = await call(operator, "POST", "/api/clients", { name: "Yangi Mijoz", phones: [], case: { matter: "Ish", status: "done", contractDate: "2026-09-15" } });
  assert.equal(staff.status, 403);
  assert.deepEqual(created, []);
  const ok = await call(operator, "POST", "/api/clients", { name: "Yangi Mijoz", phones: [], case: { matter: "Ish", status: "consultation", lawyer: "", lawyerId: null } });
  assert.equal(ok.status, 201);
  const manager = await call(boss, "POST", "/api/clients/1/cases", { matter: "Eski ish", status: "done", contractDate: "2026-09-15" });
  assert.equal(manager.status, 201);
  assert.equal(manager.body.contractDate, "2026-09-15");
});

test("the summary page shows the lawyer only the cases the summary may be about", async () => {
  const page = async (cases, bookedById, people) => {
    prisma.appointment.findUnique = async () => ({ ...appointment({ bookedById }), calendar: { id: 1, name: "Advokat", ownerId: 3 }, bookedBy: null, summaryBy: null, case: null, start: 600, end: 660, summary: null });
    prisma.client.findUnique = async () => ({ ...client, cases });
    prisma.clientCase.findMany = async () => cases.map((k) => ({ id: k.id, matter: `Ish ${k.id}`, details: null, status: k.status, operator: null }));
    prisma.clientContact.findMany = async () => [{ id: 5, name: "Ota", relation: "father", decides: true }];
    const res = await call(lawyer, "GET", "/api/consultations/30", undefined, people);
    assert.equal(res.status, 200);
    return { cases: res.body.cases.map((k) => k.id), contacts: res.body.contacts.length };
  };
  assert.deepEqual(await page(client.cases, 3), { cases: [13], contacts: 1 });
  assert.deepEqual(await page(client.cases.slice(0, 2), 3), { cases: [], contacts: 0 });
  assert.deepEqual(await page(client.cases, 4, { 4: { id: 4, ...byOperator } }), { cases: [11, 13], contacts: 1 });
});

test("changing a case keeps the same limits", async () => {
  prisma.clientCase.findUnique = async () => ({ id: 10, clientId: 1, status: "consultation", operatorId: 7, coordinatorId: null, lawyerId: null, extraLawyers: [], client: { createdById: 99, cases: [{ operatorId: 7 }] } });
  const res = await call(operator, "PATCH", "/api/client-cases/10", { status: "done" });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "forbidden");
});
