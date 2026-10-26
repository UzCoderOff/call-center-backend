const test = require("node:test");
const assert = require("node:assert/strict");
const { SCENARIOS, byId, publicScenario } = require("../src/services/practice/scenarios");
const practice = require("../src/services/practice");

// Practice with a made-up client the AI plays (services/practice): the
// scenarios, what staff see of them, and the month's summary. No model.

test("every scenario has what the AI client and the scoring need", () => {
  const ids = new Set();
  for (const s of SCENARIOS) {
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
    ids.add(s.id);
    for (const key of ["title", "brief", "opening", "persona", "books", "leaves", "good"]) assert.ok(String(s[key] || "").trim().length > 5, `${s.id}.${key}`);
    assert.ok([1, 2, 3].includes(s.level), `${s.id}.level`);
    assert.ok(["call", "telegram"].includes(s.channel), `${s.id}.channel`);
  }
  assert.ok(SCENARIOS.length >= 8);
});

test("staff don't see the client's secrets before they start", () => {
  const s = publicScenario(byId("bank_loan"));
  assert.deepEqual(Object.keys(s).sort(), ["brief", "channel", "id", "level", "title"]);
  assert.equal(byId("nope"), null);
});

test("the client's instructions carry the persona and the conditions", () => {
  const s = byId("licence");
  const sys = practice.clientSystem(s);
  assert.match(sys, /never say you are an AI/);
  assert.ok(sys.includes(s.persona) && sys.includes(s.books) && sys.includes(s.leaves));
  assert.match(sys, /Telegram chat/);
  assert.match(practice.clientSystem(byId("bank_loan")), /phone call/);
  assert.equal(practice.talk([{ from: "client", text: "Salom" }, { from: "staff", text: "Assalomu alaykum" }], false), "MIJOZ: Salom\nOPERATOR: Assalomu alaykum");
});

test("a month of practice: tries, average, best, how they ended", () => {
  const sum = practice.summarize([
    { status: "done", score: 80, outcome: "booked" },
    { status: "done", score: 40, outcome: "left" },
    { status: "done", score: null, outcome: "stopped" },
    { status: "active", score: null, outcome: null },
  ]);
  assert.deepEqual(sum, { sessions: 3, averageScore: 60, bestScore: 80, outcomes: { booked: 1, left: 1, stopped: 1 } });
  assert.deepEqual(practice.summarize([]), { sessions: 0, averageScore: null, bestScore: null, outcomes: {} });
});
