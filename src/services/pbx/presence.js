const prisma = require("../../lib/prisma");
const state = require("./state");
const { hasJob } = require("../../lib/jobs");
const push = require("../push");

// Who answers the company line. No on/off switch (operators work remotely):
// everyone on the line whose jobs include the call center and whose phone
// can sign in — unless their phone failed to come up twice in a row, then
// they rest for a while so callers don't wait on a phone that's off.
//
// Each operator is a queue member "Local/<ext>@ring-person/n" (the dialplan
// wakes the phone, then rings it) whose busy/free state comes from the hint
// <ext>@ledger-hints (config.js renderHints).

const QUEUE = "callcenter";
const REST_AFTER_FAILURES = 2;
const REST_MS = 10 * 60 * 1000;
// Ring results that mean the phone never came up (the dialplan's own word,
// or Asterisk's when the phone's address had gone stale).
const WAKE_FAILURES = new Set(["WAKE_TIMEOUT", "CHANUNAVAIL"]);
// The phone rang: whatever the person did, the phone itself works.
const PHONE_WORKED = new Set(["ANSWER", "NOANSWER", "BUSY", "CANCEL"]);

const memberInterface = (ext) => `Local/${ext}@ring-person/n`;

async function desiredMembers(db = prisma, now = Date.now()) {
  const rows = await db.pbxExtension.findMany({
    where: { ha1Enc: { not: null }, employee: { active: true, pbxCalling: true } },
    include: { employee: { select: { name: true, job: true, extraJobs: true } } },
    orderBy: { ext: "asc" },
  });
  return rows
    .filter((r) => hasJob(r.employee, "call_center") && !(r.restingUntil && r.restingUntil.getTime() > now))
    .map((r) => ({ ext: r.ext, name: r.employee.name }));
}

// Phone IDs whose phone can be woken through Google push: their sign-in
// belongs to a Ledger app (3.0+) that gave its push address. A test
// softphone can't be woken: it counts only while signed in.
async function wakeable() {
  if (!push.configured()) return new Set();
  const rows = await prisma.pbxExtension.findMany({ where: { ha1Enc: { not: null }, secretDeviceId: { not: null } }, select: { ext: true, secretDeviceId: true } });
  if (!rows.length) return new Set();
  const devices = await prisma.device.findMany({ where: { id: { in: rows.map((r) => r.secretDeviceId) }, revokedAt: null, fcmToken: { not: null } }, select: { id: true } });
  const ok = new Set(devices.map((d) => d.id));
  return new Set(rows.filter((r) => ok.has(r.secretDeviceId)).map((r) => r.ext));
}

let running = null;
function reconcile() {
  if (!running) running = doReconcile().finally(() => (running = null));
  return running;
}

async function doReconcile() {
  const ami = state.ami;
  if (!state.enabled || !ami?.ready) return;
  const want = await desiredMembers();
  const events = await ami.actionList({ Action: "QueueStatus", Queue: QUEUE });
  const have = new Set(events.filter((e) => e.Event === "QueueMember").map((e) => e.Interface || e.Location));
  const wanted = new Set(want.map((m) => memberInterface(m.ext)));
  for (const m of want) {
    if (have.has(memberInterface(m.ext))) continue;
    await ami.action({ Action: "QueueAdd", Queue: QUEUE, Interface: memberInterface(m.ext), MemberName: m.name, StateInterface: `hint:${m.ext}@ledger-hints` });
  }
  for (const iface of have) if (!wanted.has(iface)) await ami.action({ Action: "QueueRemove", Queue: QUEUE, Interface: iface });

  const all = await prisma.pbxExtension.findMany({ select: { ext: true } });
  const wake = await wakeable();
  for (const { ext } of all) {
    await ami.action({ Action: "Setvar", Variable: `DEVICE_STATE(Custom:ledger${ext})`, Value: wake.has(ext) ? "NOT_INUSE" : "UNAVAILABLE" });
  }
}

// A ring result for a phone ID on its own (a ring with no call file, e.g. a
// call between colleagues; ingest.js).
async function noteRing(ext, status, now = new Date()) {
  if (WAKE_FAILURES.has(status)) await phoneFailed(ext, now);
  else if (PHONE_WORKED.has(status)) await phoneWorked(ext);
}

// All the rings of one call (ingest.js), per phone ID: the phone worked if it
// rang at least once; the call counts as one "didn't come up" only if it
// never did — a slow wake-up that rang on the next try isn't a phone that's
// off.
async function noteCallRings(rings, now = new Date()) {
  for (const [ext, verdict] of ringVerdicts(rings)) {
    if (verdict === "worked") await phoneWorked(ext);
    else await phoneFailed(ext, now);
  }
}

// ext -> "worked" | "failed" for one call's rings (phone IDs with neither,
// e.g. the caller hung up while it was waking, are left out).
function ringVerdicts(rings) {
  const verdicts = new Map();
  for (const r of rings) {
    if (!r.ext || !r.status) continue;
    if (PHONE_WORKED.has(r.status)) verdicts.set(r.ext, "worked");
    else if (WAKE_FAILURES.has(r.status) && !verdicts.has(r.ext)) verdicts.set(r.ext, "failed");
  }
  return verdicts;
}

// Two "never came up" in a row and they rest.
async function phoneFailed(ext, now) {
  const row = await prisma.pbxExtension.findUnique({ where: { ext } });
  if (!row) return;
  const streak = row.wakeFailStreak + 1;
  const rest = streak >= REST_AFTER_FAILURES;
  await prisma.pbxExtension.update({
    where: { id: row.id },
    data: { wakeFailStreak: rest ? 0 : streak, ...(rest ? { restingUntil: new Date(now.getTime() + REST_MS) } : {}) },
  });
  if (rest) {
    console.warn(`[pbx] ${ext}: the phone didn't come up twice in a row — off the call-center line for ${REST_MS / 60000} minutes`);
    await reconcile();
  }
}

// The phone rang or signed in: whatever the person did, the phone works —
// the count starts again, and if they were resting they're back on the line.
async function phoneWorked(ext, { signedIn = false } = {}) {
  const row = await prisma.pbxExtension.findUnique({ where: { ext: String(ext || "") } });
  if (!row || !(row.wakeFailStreak || row.restingUntil)) return;
  const wasResting = row.restingUntil && row.restingUntil.getTime() > Date.now();
  await prisma.pbxExtension.update({ where: { id: row.id }, data: { wakeFailStreak: 0, restingUntil: null } });
  if (wasResting) {
    console.log(`[pbx] ${ext}: the phone ${signedIn ? "signed in" : "rang"} again — back on the call-center line`);
    await reconcile();
  }
}

// A phone signed in to the line (Asterisk's ContactStatus event).
const phoneSignedIn = (ext) => phoneWorked(ext, { signedIn: true });

module.exports = { QUEUE, memberInterface, desiredMembers, reconcile, noteRing, noteCallRings, ringVerdicts, phoneSignedIn, WAKE_FAILURES, REST_MS };
