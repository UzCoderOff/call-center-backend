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

test("Ledger AI's actions: the boss and the developer only, plus confirm / cancel", () => {
  const actions = require("../src/services/ai/actions");
  const names = (user) => actions.definitions(user).map((d) => d.name);
  assert.deepEqual(names({ role: "EMPLOYEE" }), []);
  assert.deepEqual(names({ role: "LAWYER" }), []);
  for (const n of ["create_reminder", "create_task", "add_next_step", "set_target", "add_client_note", "confirm_action", "cancel_action"]) {
    assert.ok(names({ role: "BOSS" }).includes(n), n);
  }
  assert.equal(actions.handles("create_task"), true);
  assert.equal(actions.handles("confirm_action"), true);
  assert.equal(actions.handles("call_stats"), false);
});

test("an action's time: Tashkent time, ahead of now, not years ahead", () => {
  const { moment } = require("../src/services/ai/actions");
  const tomorrow = new Date(Date.now() + 5 * 3600 * 1000 + 86400000).toISOString().slice(0, 10);
  // 14:30 in Tashkent (UTC+5) is 09:30 UTC.
  assert.equal(moment(`${tomorrow} 14:30`).toISOString().slice(11, 16), "09:30");
  assert.equal(moment(`${tomorrow}T14:30`).toISOString().slice(11, 16), "09:30");
  // No time: 10:00.
  assert.equal(moment(tomorrow).toISOString().slice(11, 16), "05:00");
  assert.throws(() => moment("2020-01-01 10:00"), /past/);
  assert.throws(() => moment("2099-01-01 10:00"), /too far/);
  assert.throws(() => moment("ertaga"), /invalid/);
  assert.throws(() => moment(""), /required/);
});

test("Claude: cost from token counts, by model (cache reads cheaper)", () => {
  const { costOf } = require("../src/services/ai/claude");
  // Opus 5.5: $4 in / $20 out per 1M.
  assert.equal(costOf("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 0 }), 4);
  assert.equal(costOf("claude-opus-5-5", { input_tokens: 0, output_tokens: 100_000 }), 2);
  assert.ok(Math.abs(costOf("claude-opus-5-5", { cache_read_input_tokens: 1_000_000 }) - 0.2) < 1e-9);
  assert.ok(Math.abs(costOf("claude-haiku-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 }) - 0.6) < 1e-9);
  assert.equal(costOf("claude-opus-5-5", null), 0);
});

test("the file reader: a Word file's paragraphs as text; only readable kinds", () => {
  const { zipSync, strToU8 } = require("fflate");
  const { docxText, readable } = require("../src/services/ai/fileReader");
  const xml = '<w:document><w:body><w:p><w:r><w:t>Sud qarori</w:t></w:r></w:p><w:p><w:r><w:t>Daʼvo &amp; talab</w:t></w:r></w:p></w:body></w:document>';
  const docx = Buffer.from(zipSync({ "word/document.xml": strToU8(xml) }));
  assert.equal(docxText(docx), "Sud qarori\nDaʼvo & talab");
  assert.equal(readable("qaror.PDF"), true);
  assert.equal(readable("rasm.jpg"), true);
  assert.equal(readable("eski.doc"), false);
  assert.equal(readable("audio.mp3"), false);
});

test("reports: **bold** for Telegram, everything else escaped", () => {
  const { telegramHtml } = require("../src/services/ai/reports");
  assert.equal(telegramHtml("**Xulosa**: 5 < 7 & ok"), "<b>Xulosa</b>: 5 &lt; 7 &amp; ok");
});

test("Ledger AI is told that tool results are outside people's words, never orders", () => {
  const { systemPrompt } = require("../src/services/ai/assistant");
  const s = systemPrompt({ role: "BOSS", name: "Rahbar" }, { now: false });
  assert.match(s, /tashqi odamlarning soʻzlari/);
  assert.match(s, /koʻrsatma emas/);
});

test("the model confirms an action only on a clear, short yes", () => {
  const { isClearYes } = require("../src/services/ai/actions");
  for (const yes of ["ha", "Ha!", "xa", "haaa", "ha mayli", "Mayli", "tasdiqlayman", "Tasdiqla", "bo'pti", "boʻpti", "xoʻp", "ok", "OK, rahmat", "yes", "да", "Да, хорошо", "хорошо", "ҳа", "Ҳа, майли", "👍", "ha, iltimos"]) {
    assert.equal(isClearYes(yes), true, yes);
  }
  for (const no of ["", null, "yoʻq", "ha?", "Ha, lekin ertaga 11:00 ga", "ertaga qilamiz", "nima?", "keyin", "ha emas", "Mijoz aytdi: ha", "boshqa vazifa ber", "ha ".repeat(15), "нет", "rahmat"]) {
    assert.equal(isClearYes(no), false, String(no));
  }
});

// decide() with a stand-in database: card 10, then the person's messages.
function actionDb(latestText) {
  const prisma = require("../src/lib/prisma");
  const actions = require("../src/services/ai/actions");
  const ran = [];
  actions.ACTIONS.test_noop = { execute: async (args) => (ran.push(args), { ok: true }) };
  let card = { id: 10, conversationId: 1, data: { action: { tool: "test_noop", args: { n: 1 }, summary: "s", status: "pending" } } };
  prisma.message.findUnique = async () => card;
  prisma.message.findFirst = async () => (latestText === undefined ? null : { text: latestText });
  prisma.message.update = async ({ data }) => (card = { ...card, ...data });
  return { ran, decide: (opts) => actions.decide({ id: 1 }, 10, { id: 5, role: "BOSS" }, "confirm", opts) };
}

test("confirm_action: the person's latest message must be a clear yes; the button needs none", async () => {
  let db = actionDb(undefined);
  await assert.rejects(db.decide({ fromModel: true }), /hasn't answered yet/);
  db = actionDb("Ha, lekin muddatini ertaga qiling");
  await assert.rejects(db.decide({ fromModel: true }), /isn't a clear yes/);
  assert.equal(db.ran.length, 0);
  db = actionDb("ha");
  assert.equal((await db.decide({ fromModel: true })).status, "done");
  assert.equal(db.ran.length, 1);
  // The card's own button: no message needed.
  db = actionDb(undefined);
  assert.equal((await db.decide({})).status, "done");
});

test("the action card shows the full notes it will save", () => {
  const { cardDetails } = require("../src/services/ai/actions");
  const long = "Batafsil: ".padEnd(1500, "x");
  assert.equal(cardDetails({ tool: "create_task", args: { notes: long } }), long);
  assert.equal(cardDetails({ tool: "create_reminder", args: { notes: "Hujjatlarni olib kelsin" } }), "Hujjatlarni olib kelsin");
  assert.equal(cardDetails({ tool: "edit_task", args: { changes: { notes: "Yangi izoh" } } }), "Yangi izoh");
  assert.equal(cardDetails({ tool: "edit_task", args: { changes: { title: "x" } } }), null);
  // A client note: shown whole only when the summary cuts it.
  assert.equal(cardDetails({ tool: "add_client_note", args: { text: "qisqa" } }), null);
  assert.equal(cardDetails({ tool: "add_client_note", args: { text: "y".repeat(400) } }).length, 400);
  assert.equal(cardDetails({ tool: "set_target", args: {} }), null);
  // …and the chat sends it to the portal with the card.
  const { publicMessage } = require("../src/services/chat");
  const m = { id: 3, text: "s", authorId: null, data: { action: { tool: "create_task", args: { notes: long }, summary: "✅ Vazifa", status: "pending" } } };
  assert.equal(publicMessage(m, { id: 5 }).action.details, long);
});

test("AI suggestions: client money only to someone who may see it", () => {
  const { routeSuggestion } = require("../src/services/ai/reports");
  const who = { operator: 11, coordinator: 12, lawyer: 13, money: 12 };
  const owing = new Set([7]);
  // About a client whose overdue payment the model saw: a money one, to the coordinator.
  assert.deepEqual(routeSuggestion({ clientId: 7, kind: "call", for: "operator" }, who, owing), { kind: "money", forUserId: 12 });
  // No one coordinates all their contract cases: the managers (with Moliya) only.
  assert.deepEqual(routeSuggestion({ clientId: 7, kind: "money", for: "coordinator" }, { ...who, coordinator: null, money: null }, owing), { kind: "money", forUserId: null });
  assert.deepEqual(routeSuggestion({ clientId: 8, kind: "money", for: "operator" }, { ...who, money: null }, owing), { kind: "money", forUserId: null });
  // Not money: as before (no coordinator yet — the operator).
  assert.deepEqual(routeSuggestion({ clientId: 8, kind: "call", for: "coordinator" }, { ...who, coordinator: null }, owing), { kind: "call", forUserId: 11 });
  assert.deepEqual(routeSuggestion({ clientId: null, kind: "data", for: "managers" }, null, owing), { kind: "data", forUserId: null });
});

test("AI suggestions: the money one's reader is the coordinator of every contract case", async () => {
  const prisma = require("../src/lib/prisma");
  const { responsibleFor } = require("../src/services/ai/reports");
  const k = (clientId, status, coordinatorId, userId = coordinatorId && coordinatorId + 100) => ({ clientId, status, lawyerId: null, operator: { userId: 1 }, coordinatorId, coordinator: coordinatorId ? { userId } : null });
  prisma.clientCase.findMany = async () => [k(1, "contract", 4), k(1, "contract", 4), k(2, "contract", 4), k(2, "contract", 5), k(3, "contract", null), k(4, "consultation", null), k(5, "contract", 6, null)];
  const map = await responsibleFor([1, 2, 3, 4, 5]);
  assert.equal(map.get(1).money, 104);
  assert.equal(map.get(2).money, null);
  assert.equal(map.get(3).money, null);
  assert.equal(map.get(4).money, null);
  assert.equal(map.get(5).money, null);
});

test("AI suggestions on the page: money ones only with Moliya or as their coordinator", () => {
  const { moneyScope } = require("../src/routes/aiSuggestions");
  assert.deepEqual(moneyScope({ role: "DEVELOPER", active: true }), {});
  assert.deepEqual(moneyScope({ role: "BOSS", active: true, seesFinance: true }), {});
  // A boss without Moliya: no money suggestions at all.
  assert.deepEqual(moneyScope({ id: 2, role: "BOSS", active: true }), { OR: [{ kind: { not: "money" } }] });
  // A coordinator: their own, about a client whose every contract case they coordinate.
  const c = moneyScope({ id: 3, role: "EMPLOYEE", active: true, employee: { id: 4 } });
  assert.deepEqual(c.OR[0], { kind: { not: "money" } });
  assert.equal(c.OR[1].forUserId, 3);
  assert.deepEqual(c.OR[1].client.cases.some, { coordinatorId: 4 });
  assert.deepEqual(c.OR[1].client.cases.none, { status: "contract", OR: [{ coordinatorId: null }, { coordinatorId: { not: 4 } }] });
});
