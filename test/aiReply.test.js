const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../src/services/aiReply/prompt");
const ig = require("../src/services/igInbox");

// The AI that answers new people (services/aiReply): what it is told and how
// its answers are read. No database, no model.

test("free times read as bugun / ertaga / a weekday", () => {
  const words = P.slotWords(
    [
      { date: "2026-10-26", start: 17 * 60 },
      { date: "2026-10-27", start: 11 * 60 },
      { date: "2026-10-29", start: 9 * 60 + 30 },
    ],
    "2026-10-26"
  );
  assert.deepEqual(words, ["bugun (dushanba, 26-oktabr) 17:00", "ertaga (seshanba, 27-oktabr) 11:00", "payshanba, 29-oktabr 9:30"]);
});

test("the prompt carries the firm's facts, the time and the free times", () => {
  const s = P.system({ facts: P.DEFAULT_FACTS, rules: P.DEFAULT_RULES, platform: "instagram", now: { date: "2026-10-26", minutes: 22 * 60 }, workHours: { from: 540, to: 1260 }, slots: [{ date: "2026-10-27", start: 660 }] });
  assert.match(s, /450 000/);
  assert.match(s, /600 000/);
  assert.match(s, /Instagram/);
  assert.match(s, /soat 22:00/);
  assert.match(s, /tashqarisida/);
  assert.match(s, /ertaga \(seshanba, 27-oktabr\) 11:00/);
  // No calendar: two parts of the day instead of made-up times.
  assert.match(P.system({ facts: "f", rules: "r", now: { date: "2026-10-26", minutes: 600 }, slots: [] }), /No free times are known now/);
});

test("the chat as the model reads it", () => {
  const t = P.transcript([
    { from: "them", kind: "text", text: "Salom" },
    { from: "ai", kind: "text", text: "Assalomu alaykum!" },
    { from: "them", kind: "voice", text: null },
    { from: "operator", kind: "text", text: "Men operatorman" },
  ]);
  assert.equal(t, "MIJOZ: Salom\nSIZ: Assalomu alaykum!\nMIJOZ: [ovozli xabar — eshitib boʻlmaydi]\nOPERATOR: Men operatorman");
});

test("answers are cleaned to one shape; a hand-off reason makes it a hand-off", () => {
  const out = P.clean({ reply: "  Salom  ", stage: "listening", handoff: "urgent", lead: { name: "Ali", format: "zoom" }, script: "klingon" });
  assert.equal(out.reply, "Salom");
  assert.equal(out.stage, "handoff");
  assert.equal(out.lead.format, "");
  assert.equal(out.lead.name, "Ali");
  assert.equal(out.script, "latin");
  // Agreeing wins over a hand-off reason (they agreed; the operators are told anyway).
  assert.equal(P.clean({ reply: "x", stage: "agreed", handoff: "payment" }).stage, "agreed");
  assert.equal(P.clean({ stage: "nonsense" }).stage, "listening");
  assert.equal(P.clean(null).reply, "");
});

test("the schema asks for every field (OpenAI strict mode)", () => {
  assert.deepEqual([...P.SCHEMA.required].sort(), Object.keys(P.SCHEMA.properties).sort());
  const lead = P.SCHEMA.properties.lead;
  assert.deepEqual([...lead.required].sort(), Object.keys(lead.properties).sort());
  assert.deepEqual([...P.CHECK_SCHEMA.required].sort(), Object.keys(P.CHECK_SCHEMA.properties).sort());
});

test("Instagram messages: text, photo, voice, file", () => {
  assert.deepEqual(ig.parse({ message: "Salom" }), { kind: "text", text: "Salom" });
  assert.equal(ig.parse({ attachments: { data: [{ image_data: { url: "u" } }] } }).kind, "photo");
  assert.equal(ig.parse({ attachments: { data: [{ audio_data: { url: "u" } }] } }).kind, "voice");
  assert.deepEqual(ig.parse({ message: "hujjat", attachments: { data: [{ file_url: "u", name: "ariza.pdf" }] } }), { kind: "document", text: "hujjat", fileName: "ariza.pdf" });
  assert.equal(ig.parse({}).kind, "other");
});
