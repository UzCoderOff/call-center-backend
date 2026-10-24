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
    grossErrors: [{ key: "promised_result", quote: "100 foiz yutamiz" }, { key: "promised_result", quote: "again" }, { key: "made_up", quote: "x" }, { key: "rude", quote: "" }],
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
  assert.deepEqual(r.grossErrors, ["Natija vaʼda qildi yoki foizda imkoniyat aytdi: «100 foiz yutamiz»"]);
  assert.equal(clean({ grossErrors: ["Qoʻpol xato yoʻq"] }).grossErrors.length, 0);
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

test("an operator's rating: stars from the average, a word, the trend, best and worst parts", () => {
  const { rate, MIN_REVIEWS } = require("../src/services/callRating");
  const review = (score, shares) => ({
    score,
    details: { criteria: CRITERIA.map((key) => ({ key, points: Math.round((shares[key] ?? 0.65) * MAX[key]) })), grossErrors: score < 50 ? ["x"] : [] },
    at: "2026-10-20T10:00:00.000Z",
  });
  assert.deepEqual(rate([review(90, {}), review(80, {})]), { count: 2, enough: false, needed: MIN_REVIEWS });
  // Newest first: the newer five ~84, the older five ~44 — going up.
  const list = [
    ...[86, 84, 82, 85, 83].map((s) => review(s, { greeting: 1, manner: 0.9, summary: 0.2 })),
    ...[44, 46, 42, 45, 43].map((s) => review(s, { greeting: 1, manner: 0.9, summary: 0.2 })),
  ];
  const r = rate(list);
  assert.equal(r.enough, true);
  assert.equal(r.score, 64);
  assert.equal(r.stars, 3.2);
  assert.equal(r.level, "fair");
  assert.equal(r.trend, "up");
  assert.deepEqual(
    r.best.map((p) => p.key),
    ["greeting", "manner"]
  );
  assert.equal(r.worst[0].key, "summary");
  assert.equal(r.gross, 5);
});

test("the Monday tip: last week's score and change, best parts, one thing to work on, a line said better", () => {
  const { operatorMessage, teamMessage, summarize, weekLabel } = require("../src/services/coaching");
  const f = require("../src/services/telegram/format");
  const review = (score, summaryShare, betterLines = []) => ({
    score,
    details: {
      criteria: CRITERIA.map((key) => ({ key, points: Math.round(MAX[key] * (key === "summary" ? summaryShare : key === "greeting" ? 1 : 0.75)), note: key === "summary" ? "Vaziyat qaytarilmadi" : "" })),
      betterLines,
    },
  });
  const week = [review(70, 0.2, [{ said: "Qachon qulay?", better: "Bugun 17:00 yoki 18:00?" }]), review(74, 0.3), review(66, 0.1)];
  const text = operatorMessage({ week, before: [review(60, 0.2)], label: weekLabel("2026-10-19", "2026-10-25"), link: "", f });
  assert.match(text, /19–25-oktabr/);
  assert.match(text, /oʻrtacha <b>70\/100<\/b> \(oldingi hafta 60, ↑ 10\)/);
  assert.match(text, /Eng yaxshisi: Salomlashish \(100%\)/);
  assert.match(text, /ustida ishlang: Xulosa/);
  assert.match(text, /Vaziyat qaytarilmadi/);
  assert.match(text, /«Qachon qulay\?» oʻrniga/);
  // Too few calls: nothing.
  assert.equal(operatorMessage({ week: week.slice(0, 2), before: [], label: "", link: "", f }), null);
  const team = teamMessage({ rows: [{ name: "Aziz", week: summarize(week), before: summarize([review(75, 0.2)]) }, { name: "Yangi", week: null }], label: "x", link: "", f });
  assert.match(team, /Aziz — 70\/100 \(3 ta\) ↓5 · ustida ishlash: Xulosa/);
  assert.doesNotMatch(team, /Yangi/);
});

test("call text is written with the proper Uzbek letters", () => {
  const { uzLetters } = require("../src/services/pbx/transcribe");
  assert.equal(uzLetters("O'tdi, bo'ldi, g'alaba, ma'lum, qo`ydim"), "Oʻtdi, boʻldi, gʻalaba, maʼlum, qoʻydim");
  assert.equal(uzLetters("'Salom' dedi"), "'Salom' dedi");
  assert.equal(uzLetters("Xo 'p, bo 'ldi. Qo 'ymadingiz -a?"), "Xoʻp, boʻldi. Qoʻymadingiz-a?");
});
