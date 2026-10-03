const prisma = require("../../lib/prisma");
const state = require("./state");
const { hasJob } = require("../../lib/jobs");

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

// Phone IDs whose phone can be woken through Google push (the Ledger app,
// from app 3.0). Until then, only a phone that's signed in right now counts.
async function wakeable() {
  return new Set();
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

// A ring result for a phone ID (from ingest.js): two "never came up" in a
// row and they rest; any real ring resets the count.
async function noteRing(ext, status, now = new Date()) {
  const row = await prisma.pbxExtension.findUnique({ where: { ext } });
  if (!row) return;
  if (WAKE_FAILURES.has(status)) {
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
  } else if (PHONE_WORKED.has(status) && (row.wakeFailStreak || row.restingUntil)) {
    await prisma.pbxExtension.update({ where: { id: row.id }, data: { wakeFailStreak: 0, restingUntil: null } });
  }
}

module.exports = { QUEUE, memberInterface, desiredMembers, reconcile, noteRing, WAKE_FAILURES, REST_MS };
