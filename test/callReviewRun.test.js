const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/lib/prisma");
const claude = require("../src/services/ai/claude");
const notify = require("../src/services/telegram/notify");
const { reviewCall, CRITERIA } = require("../src/services/callReview");

// reviewCall end to end, with a stand-in database and Claude: what is saved,
// who is told.
const CRIT = CRITERIA.map((key) => ({ key, points: 5, note: "ok" }));
const answer = (extra = {}) => ({ kind: "lead", topic: "Kripto", outcome: "not_booked", about: "Maslahat soʻradi", lost: false, criteria: CRIT, grossErrors: [], good: [], improve: [], betterLines: [], ...extra });

function setup(answers) {
  const saved = [];
  const alerts = [];
  let asked = 0;
  prisma.setting.findUnique = async ({ where }) => (where.key === "ai" ? { value: { claudeKeyEnc: "x", claudeFeatures: { callReview: true } } } : null);
  prisma.callLog.findUnique = async () => ({
    id: 7,
    missed: false,
    durationSeconds: 120,
    callType: "incoming",
    callTimestampMs: 1793166919000n,
    phoneKey: null,
    phoneNumber: "+998901234567",
    employeeId: 2,
    employee: { name: "Operator", job: "call_center", extraJobs: "" },
    transcript: { status: "done", segments: [{ who: "staff", start: 0, end: 2, text: "Assalomu alaykum" }, { who: "client", start: 2, end: 5, text: "Boʻldi, men telefon qilib oʻtaman" }] },
  });
  prisma.callAnalysis.findMany = async () => [];
  prisma.callAnalysis.upsert = async () => ({});
  prisma.callAnalysis.update = async ({ data }) => {
    saved.push(data);
    return { id: 1, notifiedAt: new Date(), ...data };
  };
  notify.notifyUser = async (user, kind, text) => alerts.push(text);
  notify.linkedUsers = async () => [{ id: 1 }];
  notify.once = async (key, fn) => fn();
  claude.create = async () => ({ model: "claude-haiku-5-5", usage: { input_tokens: 1000, output_tokens: 1000 }, content: [{ type: "tool_use", input: answers[Math.min(asked++, answers.length - 1)] }] });
  return { saved, alerts, asked: () => asked };
}

test("criteria sent as JSON text are scored from the first answer", async () => {
  const s = setup([answer({ criteria: JSON.stringify(CRIT) })]);
  await reviewCall(7);
  assert.equal(s.asked(), 1);
  assert.equal(s.saved[0].score, 45);
});

test("criteria missing: asked once more, and the fuller answer is kept", async () => {
  const s = setup([answer({ criteria: "nothing" }), answer()]);
  await reviewCall(7);
  assert.equal(s.asked(), 2);
  assert.equal(s.saved[0].score, 45);
  assert.equal(s.saved[0].costUsd > 0.0011, true);
});

test("criteria missing twice: not scored (no 0/100 to the operator)", async () => {
  const s = setup([answer({ criteria: "nothing" })]);
  await reviewCall(7);
  assert.equal(s.asked(), 2);
  assert.equal(s.saved[0].score, null);
  assert.equal(s.saved[0].details.unreadable, true);
  assert.equal(s.saved[0].details.unscored, true);
});

test("'lost' with no words of the caller's: no alert, no −20", async () => {
  const s = setup([answer({ lost: true, lostCause: "operator" })]);
  await reviewCall(7);
  assert.equal(s.saved[0].score, 45);
  assert.equal(s.saved[0].details.lost, false);
  assert.equal(s.alerts.length, 0);
});

test("lost through the operator, with the caller's words: −20 and the managers see the words", async () => {
  const s = setup([answer({ lost: true, lostCause: "operator", lostQuote: "Boshqa advokat topdim" })]);
  await reviewCall(7);
  assert.equal(s.saved[0].score, 25);
  assert.deepEqual(s.saved[0].details.grossErrors, ["Mijoz shu qoʻngʻiroqda yoʻqotildi: «Boshqa advokat topdim»"]);
  assert.equal(s.alerts.length, 1);
  assert.match(s.alerts[0], /Mijoz: «Boshqa advokat topdim»/);
});
