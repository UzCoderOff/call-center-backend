const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { execFileSync } = require("child_process");
const express = require("express");
const prisma = require("../src/lib/prisma");
const env = require("../src/config/env");
const { signSessionToken } = require("../src/lib/tokens");
const app = require("../src/app");

// The real app on a free port, with the database replaced per test by
// stand-ins (made-up people and calls only).
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

// Replaces obj[name] for one test (put back as it was before any test).
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

const person = (over = {}) => ({ id: 1, username: "test.boss", name: "Test Boss", role: "BOSS", active: true, mustChangePassword: false, sessionsValidAfter: null, seesFinance: false, employee: null, ...over });

// Signed in on the portal as `user` (looked up again on every request).
function signIn(t, user) {
  stub(t, prisma.user, "findUnique", async ({ where }) => (where.id === user.id ? user : null));
  stub(t, prisma.setting, "findUnique", async () => null);
  require("../src/lib/settings").clearSettingsCache();
  return `session=${signSessionToken(user)}`;
}

async function call(method, url, { cookie, body, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}), ...headers },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// ------------------------------------------------ calls from the phone line

// A phone signed in to the app (a made-up operator with call collection on).
function phoneSignedIn(t, employee = {}) {
  stub(t, prisma.device, "findUnique", async ({ where }) =>
    where.tokenHash
      ? { id: 3, revokedAt: null, lastSeenAt: new Date(), user: { id: 2, active: true, role: "EMPLOYEE", employee: { id: 4, employeeId: "test-emp-4", name: "Test Operator", active: true, collectCalls: true, ...employee } } }
      : null
  );
}

function syncForm(payload) {
  const form = new FormData();
  form.append("payload", typeof payload === "string" ? payload : JSON.stringify(payload));
  return form;
}

const AT = 1761700000000;

test("call sync: an entry with a phone-line call id is skipped, the rest of the batch is saved", async (t) => {
  phoneSignedIn(t);
  const saved = [];
  const logged = [];
  stub(t, prisma.callLog, "upsert", async (args) => {
    saved.push(args);
    return { id: saved.length };
  });
  stub(t, prisma.callLog, "findMany", async () => []);
  stub(t, prisma.syncLog, "create", async ({ data }) => logged.push(data));
  const res = await call("POST", "/api/calls/sync", {
    headers: { authorization: "Bearer test-device-token" },
    body: syncForm({
      calls: [
        { callLogId: 101, phoneNumber: "+998901234567", callType: "incoming", missed: false, callTimestampMs: AT, durationSeconds: 40 },
        // Turning a missed line call into an answered one, any letter case.
        { callLogId: "pbx:1761700000.12", phoneNumber: "+998901234568", callType: "incoming", missed: false, callTimestampMs: AT, durationSeconds: 300 },
        { callLogId: "PBX:1761700000.13", phoneNumber: "+998901234569", callType: "incoming", missed: false, callTimestampMs: AT, durationSeconds: 300 },
      ],
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.received, 1);
  assert.deepEqual(
    saved.map((s) => s.where.employeeId_deviceCallLogId_callTimestampMs.deviceCallLogId),
    ["101"]
  );
  assert.equal(logged.length, 1);
  assert.equal(logged[0].ok, true);
});

test("call sync: a stranger's failed attempts write no SyncLog rows; a known phone's still do", async (t) => {
  const logged = [];
  stub(t, prisma.syncLog, "create", async ({ data }) => logged.push(data));
  stub(t, prisma.employee, "findUnique", async () => null);
  stub(t, prisma.device, "findUnique", async () => null);

  // A made-up employeeId, a bad device token, no payload at all.
  assert.equal((await call("POST", "/api/calls/sync", { body: syncForm({ employeeId: "made-up-id", calls: [] }) })).status, 401);
  assert.equal((await call("POST", "/api/calls/sync", { headers: { authorization: "Bearer not-a-token" }, body: syncForm({ calls: [] }) })).status, 401);
  assert.equal((await call("POST", "/api/calls/sync", { body: new FormData() })).status, 400);
  assert.equal(logged.length, 0);

  // A real person's phone with collection switched off: kept, under their name.
  phoneSignedIn(t, { collectCalls: false });
  assert.equal((await call("POST", "/api/calls/sync", { headers: { authorization: "Bearer test-device-token" }, body: syncForm({ calls: [] }) })).status, 403);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].employeeId, "test-emp-4");
  assert.equal(logged[0].errorCode, "collection_disabled");
});

test("call sync: the payload text is limited to 2 MB (the app sends under 100 KB)", async (t) => {
  const logged = [];
  stub(t, prisma.syncLog, "create", async ({ data }) => logged.push(data));
  const { PAYLOAD_MAX_BYTES } = require("../src/routes/sync");
  assert.equal(PAYLOAD_MAX_BYTES, 2 * 1024 * 1024);
  // 400 calls, as the app sends them at most, fit with room to spare.
  const calls = Array.from({ length: 400 }, (_, i) => ({ callLogId: 100000 + i, phoneNumber: "+998901234567", callType: "incoming", missed: false, callTimestampMs: AT + i, durationSeconds: 61, recordingFilename: `${100000 + i}_Call recording Test Mijoz_251029_101500.m4a` }));
  assert.ok(Buffer.byteLength(JSON.stringify({ appVersion: "3.2.4", calls })) * 10 < PAYLOAD_MAX_BYTES);
  // Over the limit: refused before anyone is looked up, and not logged.
  stub(t, prisma.employee, "findUnique", async () => null);
  const res = await call("POST", "/api/calls/sync", { body: syncForm("x".repeat(PAYLOAD_MAX_BYTES + 1)) });
  assert.equal(res.status, 413);
  assert.equal(logged.length, 0);
});

// ------------------------------------------------ consultation fee, payments

test("consultation fee: a second request that gets in after the first finds its fee (409)", async (t) => {
  const cookie = signIn(t, person());
  // Both requests saw no fee before saving; inside the save the second sees the first's.
  stub(t, prisma.appointment, "findUnique", async () => ({ id: 5, calendarId: 1, status: "booked", clientId: 9, phoneKey: "901234567", payments: [], calendar: { ownerId: 7 } }));
  const created = [];
  stub(t, prisma, "$transaction", async (fn) =>
    fn({
      payment: { count: async ({ where }) => (where.appointmentId === 5 && where.kind === "consultation" ? 1 : 0), create: async (args) => created.push(args) },
      clientCase: { findFirst: async () => null },
      client: { update: async () => ({}) },
      appointment: { findUnique: async () => ({ id: 5 }), update: async () => ({}) },
    })
  );
  const res = await call("POST", "/api/appointments/5/fee", { cookie, body: { feeAmount: 450000, feeMethod: "card" } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "fee_already_recorded");
  assert.equal(created.length, 0);
});

test("client payment and cash handover sent twice in a moment: the first one is the answer", async (t) => {
  const cookie = signIn(t, person({ role: "DEVELOPER" }));
  stub(t, prisma.client, "findUnique", async () => ({ id: 9, archivedAt: null, cases: [] }));
  const earlier = { id: 41, clientId: 9, caseId: null, amount: 1000000, date: "2026-10-29", method: "cash", kind: "contract", note: null, recordedById: 1, cashHolderId: null };
  let asked = null;
  const created = [];
  stub(t, prisma, "$transaction", async (fn) =>
    fn({
      payment: { findFirst: async (args) => ((asked = args), earlier), create: async (args) => created.push(args) },
      client: { update: async () => ({}) },
      cashHandover: {
        findFirst: async (args) => ((asked = args), { id: 7, date: "2026-10-29", amount: 500000, note: null, user: { id: 3, name: "Test Kassir" }, receivedBy: null, createdAt: new Date() }),
        create: async (args) => created.push(args),
      },
    })
  );
  const res = await call("POST", "/api/clients/9/payments", { cookie, body: { amount: 1000000, date: "2026-10-29", method: "cash", kind: "contract" } });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 41);
  assert.equal(created.length, 0);
  // Identical in every field, by the same person, within the last few seconds.
  assert.deepEqual({ ...asked.where, createdAt: undefined }, { amount: 1000000, date: "2026-10-29", method: "cash", kind: "contract", note: null, cashHolderId: null, clientId: 9, caseId: null, recordedById: 1, editedAt: null, createdAt: undefined });
  assert.ok(Date.now() - asked.where.createdAt.gte.getTime() <= 10_000);

  stub(t, prisma.user, "findUnique", async ({ where }) => (where.id === 1 ? person({ role: "DEVELOPER" }) : { id: 3 }));
  const handover = await call("POST", "/api/cash/handovers", { cookie, body: { userId: 3, amount: 500000 } });
  assert.equal(handover.status, 201);
  assert.equal(handover.body.id, 7);
  assert.equal(created.length, 0);
  assert.equal(asked.where.receivedById, 1);
});

// ------------------------------------------------ temporary passwords

test("temporary password: only who I am, changing it and signing out answer", async (t) => {
  const cookie = signIn(t, person({ mustChangePassword: true }));
  stub(t, prisma.webPushSubscription, "deleteMany", async () => ({ count: 0 }));

  const me = await call("GET", "/api/auth/me", { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.body.mustChangePassword, true);
  // Reaches the change itself (refused here only for the missing fields).
  assert.equal((await call("POST", "/api/auth/change-password", { cookie, body: {} })).status, 400);
  assert.equal((await call("DELETE", "/api/push/web", { cookie, body: { endpoint: "https://fcm.googleapis.com/fcm/send/test" } })).status, 200);
  assert.equal((await call("POST", "/api/auth/logout", { cookie })).status, 200);

  for (const [method, url] of [["GET", "/api/calls"], ["GET", "/api/push/web"], ["GET", "/api/tasks"], ["GET", "/api/clients"], ["POST", "/api/appointments/5/fee"], ["GET", "/api/users"]]) {
    const res = await call(method, url, { cookie, body: method === "POST" ? {} : undefined });
    assert.equal(res.status, 403, `${method} ${url}`);
    assert.equal(res.body.error, "must_change_password", `${method} ${url}`);
  }
});

test("temporary password: the phone app's own calls (device token) keep working", async (t) => {
  phoneSignedIn(t);
  stub(t, prisma.callLog, "upsert", async () => ({ id: 1 }));
  stub(t, prisma.callLog, "findMany", async () => []);
  stub(t, prisma.syncLog, "create", async () => ({}));
  // The person behind the phone is still on a temporary password.
  const device = await prisma.device.findUnique({ where: { tokenHash: "x" } });
  device.user.mustChangePassword = true;
  stub(t, prisma.device, "findUnique", async () => device);
  const res = await call("POST", "/api/calls/sync", {
    headers: { authorization: "Bearer test-device-token" },
    body: syncForm({ calls: [{ callLogId: 7, phoneNumber: "+998901234567", callType: "incoming", missed: false, callTimestampMs: AT, durationSeconds: 5 }] }),
  });
  assert.equal(res.status, 200);
  const session = await call("POST", "/api/device/session", { headers: { authorization: "Bearer test-device-token" } });
  assert.equal(session.status, 200);
});

// ------------------------------------------------ browser push addresses

test("browser push: only the browsers' own push services are accepted", () => {
  const { isPushServiceUrl } = require("../src/services/push/web");
  for (const ok of [
    "https://fcm.googleapis.com/fcm/send/abc:def",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
    "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA",
    "https://web.push.apple.com/QGuQyavXutnMH",
  ]) {
    assert.equal(isPushServiceUrl(ok), true, ok);
  }
  for (const bad of [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://user:pw@fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com.example.com/x",
    "https://evilfcm.googleapis.com/x",
    "https://push.apple.com.example.com/x",
    "https://notify.windows.com/x",
    "https://127.0.0.1/x",
    "https://localhost:4000/api/health",
    "https://[::1]/x",
    "not a url",
    "",
  ]) {
    assert.equal(isPushServiceUrl(bad), false, bad);
  }
});

test("browser push: a subscription for another address is refused, and an old one is never sent to", async (t) => {
  const cookie = signIn(t, person());
  const saved = [];
  stub(t, prisma.webPushSubscription, "upsert", async (args) => saved.push(args));
  const keys = { p256dh: "BTestKey", auth: "testauth" };
  assert.equal((await call("POST", "/api/push/web", { cookie, body: { endpoint: "https://127.0.0.1:4000/api/anything", keys } })).status, 400);
  assert.equal((await call("POST", "/api/push/web", { cookie, body: { endpoint: "https://fcm.googleapis.com/fcm/send/test", keys } })).status, 200);
  assert.equal(saved.length, 1);

  // Sending: one good browser, one saved before the check.
  const webpush = require("web-push");
  stub(t, env.webPush, "publicKey", "test-public");
  stub(t, env.webPush, "privateKey", "test-private");
  const sentTo = [];
  stub(t, webpush, "sendNotification", async (sub) => sentTo.push(sub.endpoint));
  stub(t, prisma.webPushSubscription, "findMany", async () => [
    { id: 1, endpoint: "https://fcm.googleapis.com/fcm/send/test", p256dh: "k", auth: "a" },
    { id: 2, endpoint: "https://10.0.0.5/internal", p256dh: "k", auth: "a" },
  ]);
  stub(t, prisma.webPushSubscription, "update", async () => ({}));
  const { sendToUser } = require("../src/services/push/web");
  assert.equal(await sendToUser(1, { title: "Test" }), true);
  assert.deepEqual(sentTo, ["https://fcm.googleapis.com/fcm/send/test"]);
});

// ------------------------------------------------ where the API listens

function hostsWith(vars) {
  const childEnv = { ...process.env, DATABASE_URL: "file:unused", JWT_SECRET: "unused-secret-for-tests", DOTENV_CONFIG_QUIET: "true" };
  delete childEnv.HOST;
  delete childEnv.NODE_ENV;
  Object.assign(childEnv, vars);
  const out = execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(require('./src/config/env').hosts))"], { cwd: path.join(__dirname, ".."), env: childEnv });
  return JSON.parse(String(out));
}

test("listening: on the server only this machine (both loopbacks); elsewhere every address; HOST overrides", () => {
  assert.deepEqual(hostsWith({ NODE_ENV: "production" }), ["127.0.0.1", "::1"]);
  assert.deepEqual(hostsWith({}), []);
  assert.deepEqual(hostsWith({ NODE_ENV: "production", HOST: "0.0.0.0" }), ["0.0.0.0"]);
  assert.deepEqual(hostsWith({ HOST: " 127.0.0.1 , ::1 " }), ["127.0.0.1", "::1"]);
});

test("listening: one listener per address, each serving the app; a taken port says where", async () => {
  const { listenAll } = require("../src/lib/listen");
  const tiny = express();
  tiny.get("/health", (req, res) => res.json({ ok: true }));
  const up = await listenAll(tiny, 0, ["127.0.0.1", "::1"]);
  try {
    // ::1 is skipped (with a warning) only on a machine without IPv6.
    assert.ok(up.some((l) => l.where.startsWith("127.0.0.1:")));
    for (const { server: s } of up) {
      const { address, port } = s.address();
      assert.ok(["127.0.0.1", "::1"].includes(address));
      const host = address.includes(":") ? `[${address}]` : address;
      assert.equal((await fetch(`http://${host}:${port}/health`)).status, 200);
    }
    const taken = up[0].server.address().port;
    await assert.rejects(listenAll(tiny, taken, ["127.0.0.1"]), (err) => err.code === "EADDRINUSE" && err.where === `127.0.0.1:${taken}`);
  } finally {
    for (const { server: s } of up) {
      s.closeAllConnections();
      s.close();
    }
  }
});

// ------------------------------------------------ the request log

test("request log: a live-listen or TV link's secret is not written in full", async (t) => {
  const lines = [];
  const log = console.log;
  t.after(() => {
    console.log = log;
  });
  console.log = (...args) => lines.push(args.join(" "));
  stub(t, prisma.setting, "findUnique", async () => null);
  require("../src/lib/settings").clearSettingsCache();
  assert.equal((await call("GET", "/api/pbx-listen/eyJTEST.SecretMac123")).status, 403);
  assert.equal((await call("GET", "/api/wallboard/tv/TvSecret456")).status, 404);
  for (let i = 0; i < 50 && lines.length < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
  console.log = log;
  const text = lines.join("\n");
  assert.match(text, /GET \/api\/pbx-listen\/\*\*\* 403/);
  assert.match(text, /GET \/api\/wallboard\/tv\/\*\*\* 404/);
  assert.doesNotMatch(text, /SecretMac123|TvSecret456|eyJTEST/);
});
