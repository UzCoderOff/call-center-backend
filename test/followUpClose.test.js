const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused-secret-for-tests";
const prisma = require("../src/lib/prisma");
const { signSessionToken } = require("../src/lib/tokens");
const app = require("../src/app");

// Who may mark a client's follow-up done (2026-10-29: the boss gave
// themselves a call on a coordinator's case; the coordinator made the call
// and got "forbidden"). The real app on a free port, the database replaced
// by stand-ins (made-up people only).

let server;
let base;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const originals = new Map();
function stub(t, obj, name, fn) {
  if (!originals.has(obj)) originals.set(obj, new Map());
  const saved = originals.get(obj);
  if (!saved.has(name)) saved.set(name, obj[name]);
  obj[name] = fn;
  t.after(() => {
    obj[name] = saved.get(name);
  });
}

const person = (over) => ({ username: "test", name: "Test", active: true, mustChangePassword: false, sessionsValidAfter: null, seesFinance: false, employee: null, ...over });
const boss = person({ id: 2, role: "BOSS" });
const coordinator = person({ id: 8, role: "EMPLOYEE", employee: { id: 6, name: "Koordinator Test", job: "coordinator", extraJobs: "", calendarAccess: "none" } });
const otherCoordinator = person({ id: 16, role: "EMPLOYEE", employee: { id: 7, name: "Boshqa Koordinator", job: "coordinator", extraJobs: "", calendarAccess: "none" } });

// A signed case: coordinator 6, a lawyer; the boss's own call about it.
const client = { id: 129, createdById: 2, archivedAt: null, cases: [{ id: 129, status: "contract", operatorId: null, coordinatorId: 6, lawyerId: 11, extraLawyers: [] }] };
const bossCall = { id: 10, clientId: 129, caseId: 129, kind: "call", status: "open", assigneeId: 2, createdById: 2, contactId: null, dueAt: new Date("2026-10-27T05:00:00Z"), note: null };

function world(t, user, followUp) {
  const saved = [];
  stub(t, prisma.user, "findUnique", async ({ where }) => (where.id === user.id ? user : null));
  stub(t, prisma.setting, "findUnique", async () => null);
  require("../src/lib/settings").clearSettingsCache();
  stub(t, prisma.clientFollowUp, "findUnique", async ({ where }) => (where.id === followUp.id ? followUp : null));
  stub(t, prisma.client, "findUnique", async ({ where }) => (where.id === client.id ? client : null));
  const tx = {
    clientFollowUp: {
      update: async (args) => (saved.push(["update", args]), { ...followUp, ...args.data, contact: null }),
      findMany: async () => [],
    },
    clientEvent: { create: async (args) => saved.push(["event", args]) },
    client: { update: async () => ({}) },
  };
  stub(t, prisma, "$transaction", async (fn) => fn(tx));
  stub(t, prisma.clientFollowUp, "update", tx.clientFollowUp.update);
  return { cookie: `session=${signSessionToken(user)}`, saved };
}

async function call(method, url, { cookie, body }) {
  const res = await fetch(base + url, { method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test("the case's coordinator marks the boss's call about it done; the history says who", async (t) => {
  const { cookie, saved } = world(t, coordinator, bossCall);
  const res = await call("POST", "/api/client-follow-ups/10/close", { cookie, body: { status: "done", outcome: "reached" } });
  assert.equal(res.status, 200);
  const update = saved.find(([k]) => k === "update")[1];
  assert.equal(update.data.status, "done");
  assert.equal(update.data.doneById, 8);
  assert.equal(saved.find(([k]) => k === "event")[1].data.authorId, 8);
});

test("moving someone else's follow-up stays theirs (and the managers')", async (t) => {
  const { cookie } = world(t, coordinator, bossCall);
  const res = await call("PATCH", "/api/client-follow-ups/10", { cookie, body: { dueAt: "2026-11-02T05:00:00.000Z" } });
  assert.equal(res.status, 403);
});

test("one about the client as a whole, given to someone else: not the coordinator's to close", async (t) => {
  const { cookie } = world(t, coordinator, { ...bossCall, caseId: null });
  const res = await call("POST", "/api/client-follow-ups/10/close", { cookie, body: { status: "done" } });
  assert.equal(res.status, 403);
});

test("someone not on the case doesn't even see it", async (t) => {
  const { cookie } = world(t, otherCoordinator, bossCall);
  const res = await call("POST", "/api/client-follow-ups/10/close", { cookie, body: { status: "done" } });
  assert.equal(res.status, 404);
});

test("the boss still closes their own", async (t) => {
  const { cookie } = world(t, boss, bossCall);
  const res = await call("POST", "/api/client-follow-ups/10/close", { cookie, body: { status: "cancelled" } });
  assert.equal(res.status, 200);
});
