const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeFields, validateAnswers, summarize } = require("../src/services/reportFields");

const FORM = normalizeFields([
  { id: "docs", label: "Nechta hujjat tarjima qilindi?", type: "number", required: true },
  { id: "cash", label: "Tushum (soʻm)", type: "money" },
  { id: "lang", label: "Tillar", type: "checklist", options: ["Rus", "Ingliz", "Turk"] },
  { id: "late", label: "Kechikdingizmi?", type: "yesno", required: true },
  { id: "note", label: "Izoh", type: "textarea" },
]);

test("a form definition is normalised: ids kept, options deduped", () => {
  const fields = normalizeFields([
    { id: "a", label: "  Savol  ", type: "select", options: ["x", "x", " y ", ""] },
    { label: "No id", type: "text" },
  ]);
  assert.equal(fields[0].label, "Savol");
  assert.deepEqual(fields[0].options, ["x", "y"]);
  assert.match(fields[1].id, /^f_[0-9a-f]{10}$/);
});

test("bad form definitions are rejected with a readable message", () => {
  assert.throws(() => normalizeFields([]), /at least one question/);
  assert.throws(() => normalizeFields([{ label: "", type: "text" }]), /no text/);
  assert.throws(() => normalizeFields([{ label: "x", type: "video" }]), /unknown type/);
  assert.throws(() => normalizeFields([{ label: "x", type: "select", options: [] }]), /at least one option/);
});

test("answers are validated and cleaned per type", () => {
  const { answers, errors } = validateAnswers(FORM, {
    docs: "12",
    cash: "1 250 000",
    lang: ["Rus", "Ingliz"],
    late: false,
    note: "  hammasi yaxshi  ",
    ignored: "not a question",
  });
  assert.deepEqual(errors, {});
  assert.deepEqual(answers, { docs: 12, cash: 1250000, lang: ["Rus", "Ingliz"], late: false, note: "hammasi yaxshi" });
});

test("missing required answers and invalid values are reported", () => {
  const { errors } = validateAnswers(FORM, { cash: "-5", lang: ["Nemis"] });
  assert.deepEqual(errors, { docs: "required", cash: "invalid", lang: "invalid", late: "required" });
});

test("a day's reports are summed per question", () => {
  const reports = [
    { answers: { docs: 5, cash: 100000, lang: ["Rus"], late: false } },
    { answers: { docs: 7, lang: ["Rus", "Turk"], late: true } },
  ];
  const s = Object.fromEntries(summarize(FORM, reports).map((x) => [x.id, x]));
  assert.equal(s.docs.total, 12);
  assert.equal(s.cash.total, 100000);
  assert.deepEqual(s.lang.counts, { Rus: 2, Ingliz: 0, Turk: 1 });
  assert.equal(s.late.yes, 1);
  assert.equal(s.note, undefined);
});
