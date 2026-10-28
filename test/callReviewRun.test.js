const test = require("node:test");
const assert = require("node:assert/strict");
const prisma = require("../src/lib/prisma");
const claude = require("../src/services/ai/claude");
const notify = require("../src/services/telegram/notify");
const { reviewCall, CRITERIA } = require("../src/services/callReview");

// reviewCall end to end, with a stand-in database and Claude: what is saved,
// who is told. Haiku's review comes as a tool call; Sonnet's check (lost?
// gross errors?) as JSON text.
const CRIT = CRITERIA.map((key) => ({ key, points: 5, note: "ok" }));
const answer = (extra = {}) => ({ kind: "lead", topic: "Kripto", outcome: "not_booked", about: "Maslahat soʻradi", criteria: CRIT, good: [], improve: [], betterLines: [], ...extra });
const NOT_LOST = { lost: false, cause: "none", quote: "", why: "Telefon qilishini aytdi", grossErrors: [] };

function setup(answers, verdict = NOT_LOST) {
  const saved = [];
  const alerts = [];
  const requests = [];
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
    transcript: {
      status: "done",
      segments: [
        { who: "staff", start: 0, end: 2, text: "Assalomu alaykum" },
        { who: "client", start: 2, end: 5, text: "Boʻldi, men telefon qilib oʻtaman" },
        { who: "staff", start: 5, end: 8, text: "Borishingiz shart emas, sizga hech narsa boʻlmaydi" },
      ],
    },
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
  claude.create = async (params) => {
    requests.push(params);
    const usage = { input_tokens: 1000, output_tokens: 1000 };
    if (params.model === "claude-sonnet-5-5") {
      if (verdict instanceof Error) throw verdict;
      return { model: params.model, usage, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(verdict) }] };
    }
    return { model: "claude-haiku-5-5", usage, stop_reason: "tool_use", content: [{ type: "tool_use", input: answers[Math.min(asked++, answers.length - 1)] }] };
  };
  return { saved, alerts, requests, asked: () => asked };
}

test("the review tool is strict, and Sonnet is asked whether a caller who wasn't booked was lost", async () => {
  const s = setup([answer()]);
  await reviewCall(7);
  assert.equal(s.requests[0].tools[0].strict, true);
  assert.equal(s.requests[1].model, "claude-sonnet-5-5");
  assert.equal(s.saved[0].score, 45);
  assert.equal(s.saved[0].details.lost, false);
  assert.equal(s.alerts.length, 0);
});

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
});

test("criteria missing twice: not scored (no 0/100 to the operator)", async () => {
  const s = setup([answer({ criteria: "nothing" })]);
  await reviewCall(7);
  assert.equal(s.asked(), 2);
  assert.equal(s.saved[0].score, null);
  assert.equal(s.saved[0].details.unreadable, true);
  assert.equal(s.saved[0].details.unscored, true);
});

test("'lost' with no words of the caller's, or no answer from Sonnet: no alert, no −20", async () => {
  for (const verdict of [{ lost: true, cause: "operator", quote: "", why: "" }, new Error("overloaded")]) {
    const s = setup([answer()], verdict);
    await reviewCall(7);
    assert.equal(s.saved[0].score, 45);
    assert.equal(s.saved[0].details.lost, false);
    assert.equal(s.alerts.length, 0);
  }
});

test("lost for the client's own reasons: kept on the call, no alert, no −20", async () => {
  const s = setup([answer()], { lost: true, cause: "client", quote: "Tekinini topdim", why: "Pulli konsultatsiyani istamadi" });
  await reviewCall(7);
  assert.equal(s.saved[0].score, 45);
  assert.equal(s.saved[0].details.lostCause, "client");
  assert.equal(s.alerts.length, 0);
});

test("lost through the operator, with the caller's words: −20 and the managers see the words", async () => {
  const s = setup([answer()], { lost: true, cause: "operator", quote: "Boshqa advokat topdim", why: "Operator vaqt taklif qilmadi" });
  await reviewCall(7);
  assert.equal(s.saved[0].score, 25);
  assert.deepEqual(s.saved[0].details.grossErrors, ["Mijoz shu qoʻngʻiroqda yoʻqotildi: «Boshqa advokat topdim»"]);
  assert.equal(s.alerts.length, 1);
  assert.match(s.alerts[0], /Mijoz: «Boshqa advokat topdim»/);
});

test("a booked caller is never lost", async () => {
  const s = setup([answer({ outcome: "booked" })], { lost: true, cause: "operator", quote: "Boshqa advokat topdim", why: "", grossErrors: [] });
  await reviewCall(7);
  assert.equal(s.requests.length, 2);
  assert.equal(s.saved[0].details.lost, false);
  assert.equal(s.alerts.length, 0);
});

test("a call the review called not relevant is a lead when Sonnet finds the caller lost", async () => {
  const s = setup([answer({ kind: "not_relevant", outcome: "not_client" })], { lost: true, cause: "client", quote: "Ishim bitdi", why: "", grossErrors: [] });
  await reviewCall(7);
  assert.equal(s.saved[0].details.kind, "lead");
  assert.equal(s.saved[0].details.outcome, "not_booked");
  assert.equal(s.saved[0].details.lostCause, "client");
  assert.equal(s.alerts.length, 0);
});

test("gross errors come from Sonnet, and only with the operator's own words (−20 each)", async () => {
  const callerWords = setup([answer({ grossErrors: [{ key: "rude", quote: "Assalomu alaykum" }] })], { ...NOT_LOST, grossErrors: [{ key: "made_up_deadline_or_discount", quote: "Bo'ldi, men telefon qilib o'taman" }] });
  await reviewCall(7);
  assert.deepEqual(callerWords.saved[0].details.grossErrors, []);
  assert.equal(callerWords.saved[0].score, 45);
  const operatorWords = setup([answer()], { ...NOT_LOST, grossErrors: [{ key: "legal_advice", quote: "borishingiz shart emas" }] });
  await reviewCall(7);
  assert.deepEqual(operatorWords.saved[0].details.grossErrors, ["Yuridik maslahat yoki xulosa berdi: «borishingiz shart emas»"]);
  assert.equal(operatorWords.saved[0].score, 25);
});
