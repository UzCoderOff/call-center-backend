const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-ai";
const env = require("../src/config/env");
if (!env.jwtSecret) env.jwtSecret = process.env.JWT_SECRET;

const { requestBody, isReasoningModel, complete } = require("../src/services/ai/openai");
const { seal, open } = require("../src/services/ai/settings");
const { definitions, cap, matches } = require("../src/services/ai/tools");

test("reasoning models get reasoning_effort, the others a low temperature", () => {
  assert.equal(isReasoningModel("gpt-5-mini"), true);
  assert.equal(isReasoningModel("o4-mini"), true);
  assert.equal(isReasoningModel("gpt-5-chat-latest"), false);
  assert.equal(isReasoningModel("gpt-4.1-mini"), false);

  const r = requestBody({ model: "gpt-5-mini", messages: [], tools: [{ name: "x", description: "", parameters: {} }] });
  assert.equal(r.reasoning_effort, "low");
  assert.equal(r.temperature, undefined);
  assert.deepEqual(r.tools, [{ type: "function", function: { name: "x", description: "", parameters: {} } }]);

  const o = requestBody({ model: "gpt-4.1-mini", messages: [] });
  assert.equal(o.temperature, 0.2);
  assert.equal(o.reasoning_effort, undefined);
  assert.equal(o.tools, undefined);
});

test("a model that turns a parameter down is asked again without it", async () => {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    if ("temperature" in body) {
      return { ok: false, status: 400, json: async () => ({ error: { message: "Unsupported value: 'temperature'", param: "temperature" } }) };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content: "Salom" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }) };
  };
  try {
    const out = await complete("sk-test", { model: "gpt-4o", messages: [{ role: "user", content: "?" }] });
    assert.equal(out.message.content, "Salom");
    assert.equal(sent.length, 2);
    assert.equal("temperature" in sent[1], false);
  } finally {
    global.fetch = realFetch;
  }
});

test("the OpenAI key is kept encrypted and opens again", () => {
  const sealed = seal("sk-proj-abc123");
  assert.equal(sealed.includes("abc123"), false);
  assert.equal(open(sealed), "sk-proj-abc123");
  assert.notEqual(seal("sk-proj-abc123"), sealed); // a new IV each time
});

test("Ledger AI's tools: managers only, money only with Moliya", () => {
  const names = (user) => definitions(user).map((d) => d.name);
  assert.deepEqual(names({ role: "EMPLOYEE" }), []);
  assert.deepEqual(names({ role: "LAWYER", seesFinance: true }), []);
  assert.equal(names({ role: "BOSS" }).includes("finance_month"), false);
  assert.equal(names({ role: "BOSS", seesFinance: true }).includes("finance_month"), true);
  assert.equal(names({ role: "DEVELOPER" }).includes("finance_month"), true);
  assert.equal(names({ role: "BOSS" }).includes("call_stats"), true);
});

test("long lists are cut, and BigInt never reaches JSON", () => {
  const out = cap({ list: Array.from({ length: 30 }, (_, i) => i), big: 12n, none: null }, 5);
  assert.deepEqual(out, { list: { first: [0, 1, 2, 3, 4], total: 30 }, big: 12 });
  assert.doesNotThrow(() => JSON.stringify(out));
});

test("names match however they're typed", () => {
  assert.equal(matches("Dilnoza Karimova", "dilnoza"), true);
  assert.equal(matches("Dilnoza Karimova", "Дилноза"), true);
  assert.equal(matches("Dilnoza Karimova", "karimova dil"), true);
  assert.equal(matches("Dilnoza Karimova", "aziz"), false);
  assert.equal(matches("Dilnoza Karimova", ""), false);
});
