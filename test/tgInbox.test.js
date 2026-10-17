const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused-secret-for-tests";
const { parse, phoneIn, phoneFrom, seesInbox, handlesNew, displayName } = require("../src/services/tgInbox");
const { transcript, words, clean, DEFAULT_RULES } = require("../src/services/tgReview");

test("a Telegram message: what kind it is and what we keep", () => {
  assert.deepEqual(parse({ text: "Assalomu alaykum" }), { kind: "text", text: "Assalomu alaykum" });
  assert.deepEqual(parse({ photo: [{ file_id: "small" }, { file_id: "big" }], caption: "qaror" }), { kind: "photo", text: "qaror", fileId: "big" });
  assert.deepEqual(parse({ voice: { file_id: "v1", duration: 23 } }), { kind: "voice", text: null, fileId: "v1", duration: 23 });
  assert.equal(parse({ document: { file_id: "d1", file_name: "shartnoma.pdf" } }).fileName, "shartnoma.pdf");
  assert.deepEqual(parse({ sticker: { emoji: "👍" } }), { kind: "sticker", text: "👍" });
  assert.equal(parse({ contact: { first_name: "Ali", phone_number: "+998901234567" } }).text, "Ali · +998901234567");
  assert.equal(parse({ location: { latitude: 41.3, longitude: 69.2 } }).text, "41.3,69.2");
  assert.equal(parse({ poll: {} }).kind, "other");
  assert.equal(parse({ text: "x".repeat(5000) }).text.length, 4096);
});

test("a phone number in what they wrote", () => {
  assert.equal(phoneIn("Raqamim +998 90 123 45 67, qoʻngʻiroq qiling"), "+998901234567");
  assert.equal(phoneIn("90-123-45-67"), "+998901234567");
  assert.equal(phoneIn("901234567"), "+998901234567");
  assert.equal(phoneIn("998 (93) 555-11-22"), "+998935551122");
  // Not phone numbers: an amount, a case number, a year.
  assert.equal(phoneIn("1 500 000 soʻm toʻladim"), null);
  assert.equal(phoneIn("Ish raqami 2-4127/2026"), null);
  assert.equal(phoneIn("2026-yil"), null);
  // Part of a longer number (a card, an account): not a phone.
  assert.equal(phoneIn("Karta 8600123456789012"), null);
  assert.equal(phoneIn("12345678901"), null);
  assert.equal(phoneIn(null), null);
});

test("their own number: a contact of themselves, else a number they typed", () => {
  assert.equal(phoneFrom({ contact: { phone_number: "998901112233", user_id: 55 } }, "55"), "+998901112233");
  // Someone else's contact they forwarded, or one with no Telegram account behind it: not theirs.
  assert.equal(phoneFrom({ contact: { phone_number: "998901112233", user_id: 77 } }, "55"), null);
  assert.equal(phoneFrom({ contact: { phone_number: "998901112233" } }, "55"), null);
  assert.equal(phoneFrom({ caption: "tel 93 555 11 22" }, "55"), "+998935551122");
});

test("who has the Telegram section, and who handles new people", () => {
  // Managers, and the people picked to answer the firm's Telegram (2026-10-17).
  assert.equal(seesInbox({ role: "BOSS" }), true);
  assert.equal(seesInbox({ role: "DEVELOPER" }), true);
  assert.equal(seesInbox({ role: "EMPLOYEE", employee: { job: "call_center" }, tgAnswerer: true }), true);
  assert.equal(seesInbox({ role: "EMPLOYEE", employee: { job: "call_center" }, tgAnswerer: false }), false);
  // Coordinators and lawyers: their clients in work, on the client's page only.
  assert.equal(seesInbox({ role: "EMPLOYEE", employee: { job: "coordinator" } }), false);
  assert.equal(seesInbox({ role: "LAWYER" }), false);
  assert.equal(handlesNew({ role: "EMPLOYEE", employee: { job: "call_center" }, tgAnswerer: true }), true);
  assert.equal(handlesNew({ role: "EMPLOYEE", employee: { job: "call_center" } }), false);
  assert.equal(handlesNew({ role: "BOSS" }), true);
  // What they may see: answerers new people and clients before a contract;
  // a coordinator only the clients they look after.
  const { chatScope } = require("../src/services/tgInbox");
  assert.deepEqual(chatScope({ role: "BOSS" }), {});
  assert.ok(JSON.stringify(chatScope({ role: "EMPLOYEE", employee: { id: 4 }, tgAnswerer: true })).includes('"clientId":null'));
  assert.deepEqual(chatScope({ role: "EMPLOYEE", employee: { id: 4 } }), { client: { is: { cases: { some: { coordinatorId: 4 } } } } });
});

test("a chat's name: their name, else @username", () => {
  assert.equal(displayName({ firstName: "Ali", lastName: "Valiyev" }), "Ali Valiyev");
  assert.equal(displayName({ username: "ali_v" }), "@ali_v");
  assert.equal(displayName({}), "Telegram");
});

test("the AI review reads the chat as text: who, when, how long they waited", () => {
  const at = (hhmm) => new Date(`2026-10-14T${hhmm}:00+05:00`);
  const text = transcript([
    { out: false, kind: "text", text: "Salom, ajrashish boʻyicha", sentAt: at("10:02") },
    { out: false, kind: "voice", duration: 42, sentAt: at("10:03") },
    { out: true, kind: "text", text: "450 000", sentAt: at("10:41") },
    { out: false, kind: "text", text: "notoʻgʻri", sentAt: at("10:42"), deletedAt: at("10:43") },
    { out: true, auto: true, kind: "text", text: "Hozir ishda emasmiz", sentAt: at("20:00") },
  ]);
  const lines = text.split("\n");
  assert.equal(lines[0], "[2026-10-14 10:02] MIJOZ: Salom, ajrashish boʻyicha");
  assert.equal(lines[1], "[2026-10-14 10:03] MIJOZ: [ovozli xabar, 0:42 — eshitib boʻlmaydi]");
  assert.equal(lines[2], "[2026-10-14 10:41] OPERATOR (mijoz 39 daqiqa kutdi): 450 000");
  assert.equal(lines[3], "[2026-10-14 10:42] MIJOZ: [oʻchirilgan xabar]");
  // Telegram's own away message isn't the operator's answer.
  assert.equal(lines[4], "[2026-10-14 20:00] AVTOMATIK XABAR: Hozir ishda emasmiz");
  assert.equal(words({ kind: "document", fileName: "qaror.pdf", text: "" }), "[fayl: qaror.pdf]");
  assert.equal(words({ kind: "photo", text: "chaqiruv" }), "[rasm] chaqiruv");
});

test("whatever the AI sends back, the review has one shape", () => {
  const r = clean({ relevant: "true", topic: "Meros", outcome: "made_up", score: "7", good: "Tez javob", improve: null, betterReply: null });
  assert.equal(r.relevant, true);
  assert.equal(r.outcome, "open");
  assert.equal(r.score, 5);
  assert.deepEqual(r.good, ["Tez javob"]);
  assert.deepEqual(r.improve, []);
  assert.equal(r.betterReply, null);
  assert.equal(clean({ relevant: false }).outcome, "not_client");
  assert.equal(clean({ good: ["a", "b", "c", "d"] }).good.length, 3);
  // The firm's order is in the default rules: the problem first, then the offer.
  assert.match(DEFAULT_RULES, /avval mijozning muammosini/);
});
