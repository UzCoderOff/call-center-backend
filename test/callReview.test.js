const test = require("node:test");
const assert = require("node:assert/strict");
const { clean, transcriptText, reviewable, CRITERIA, MAX } = require("../src/services/callReview");
const { cleanSegments } = require("../src/services/pbx/transcribe");

test("the review's points stay within each criterion and the total is out of 100", () => {
  const r = clean({
    kind: "lead",
    topic: "Jinoyat — chaqiruv",
    outcome: "booked",
    about: "Ukasi chaqirilgan, maslahat soʻradi",
    criteria: [
      { key: "greeting", points: 10, note: "ok" },
      { key: "routing", points: 99, note: "too many" },
      { key: "listening", points: 12, note: "" },
      { key: "questions", points: -3, note: "" },
      // "summary" missing: 0
      { key: "offer", points: 8, note: "" },
      { key: "priceTime", points: 15, note: "" },
      { key: "closing", points: 9, note: "" },
      { key: "manner", points: 9.6, note: "" },
    ],
    grossErrors: ["Natija vaʼda qildi"],
    good: ["Ismi bilan murojaat qildi", "", "Ikki vaqt taklif qildi", "extra", "more"],
    improve: [],
    betterLines: [{ said: "Qachon qulay?", better: "Ertaga 11:00 yoki payshanba 16:00?" }, { said: "", better: "x" }],
  });
  assert.deepEqual(
    r.criteria.map((c) => c.key),
    CRITERIA
  );
  assert.equal(r.criteria.find((c) => c.key === "routing").points, MAX.routing);
  assert.equal(r.criteria.find((c) => c.key === "questions").points, 0);
  assert.equal(r.criteria.find((c) => c.key === "summary").points, 0);
  assert.equal(r.criteria.find((c) => c.key === "manner").points, 10);
  // 10 + 5 + 12 + 0 + 0 + 8 + 15 + 9 + 10 = 69, minus 20 for one gross error.
  assert.equal(r.score, 49);
  assert.deepEqual(r.good, ["Ismi bilan murojaat qildi", "Ikki vaqt taklif qildi", "extra"]);
  assert.equal(r.betterLines.length, 1);
  assert.equal(clean({ grossErrors: ["a", "b", "c", "d", "e"] }).score, 0);
  assert.equal(Object.values(MAX).reduce((a, b) => a + b, 0), 100);
});

test("the transcript reads as turns: who said what, when", () => {
  const segments = cleanSegments([
    { who: "client", start: 3.2, end: 6, text: " Assalomu alaykum " },
    { who: "staff", start: 0.5, end: 3, text: "Mir Said Baraka Himoya, assalomu alaykum!" },
    { who: "robot", start: 7, end: 8, text: "?" },
    { who: "staff", start: 9, end: 9.5, text: "   " },
  ]);
  assert.deepEqual(
    segments.map((s) => s.who),
    ["staff", "client", "mix"]
  );
  assert.equal(transcriptText(segments), "[0:00] Operator: Mir Said Baraka Himoya, assalomu alaykum!\n[0:03] Mijoz: Assalomu alaykum\n[0:07] Suhbat: ?");
});

test("only an operator's answered, long enough call is reviewed", () => {
  const operator = { job: "call_center", extraJobs: "" };
  assert.equal(reviewable({ missed: false, durationSeconds: 60, employee: operator }), true);
  assert.equal(reviewable({ missed: false, durationSeconds: 10, employee: operator }), false);
  assert.equal(reviewable({ missed: true, durationSeconds: 0, employee: operator }), false);
  assert.equal(reviewable({ missed: false, durationSeconds: 60, employee: { job: "coordinator", extraJobs: "" } }), false);
});
