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

// ------------------------------------------------------------ table questions
const SERVICES = normalizeFields([
  {
    id: "services",
    label: "Xizmatlar",
    type: "table",
    required: true,
    columns: [
      { id: "kind", label: "Xizmat", type: "select", options: ["Nusxa", "Tarjima", "Ariza"] },
      { id: "people", label: "Mijozlar soni", type: "number" },
      { id: "cash", label: "Tushum", type: "money" },
      { id: "note", label: "Izoh", type: "text" },
    ],
  },
]);

test("a table question keeps its columns (ids, types, choices)", () => {
  const [field] = SERVICES;
  assert.equal(field.type, "table");
  assert.deepEqual(field.columns.map((c) => [c.id, c.type]), [["kind", "select"], ["people", "number"], ["cash", "money"], ["note", "text"]]);
  assert.throws(() => normalizeFields([{ label: "X", type: "table", columns: [] }]), /at least one column/);
  assert.throws(() => normalizeFields([{ label: "X", type: "table", columns: [{ label: "A", type: "date" }] }]), /unknown type/);
  assert.throws(() => normalizeFields([{ label: "X", type: "table", columns: [{ label: "A", type: "select", options: [] }] }]), /at least one option/);
});

test("table rows are cleaned: empty rows dropped, numbers read, bad cells refused", () => {
  const ok = validateAnswers(SERVICES, {
    services: [
      { kind: "Nusxa", people: "3", cash: "45 000" },
      { kind: "", people: "", cash: "" },
      { kind: "Tarjima", people: 2, cash: 300000, note: " tez " },
    ],
  });
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.answers.services, [
    { kind: "Nusxa", people: 3, cash: 45000 },
    { kind: "Tarjima", people: 2, cash: 300000, note: "tez" },
  ]);
  assert.equal(validateAnswers(SERVICES, { services: [{ kind: "Nusxa", cash: "-5" }] }).errors.services, "invalid");
  assert.equal(validateAnswers(SERVICES, { services: [{ kind: "Pochta" }] }).errors.services, "invalid");
  assert.equal(validateAnswers(SERVICES, { services: [{}] }).errors.services, "required");
});

test("table totals: per column, and per service", () => {
  const reports = [
    { answers: { services: [{ kind: "Nusxa", people: 3, cash: 45000 }, { kind: "Tarjima", people: 2, cash: 300000 }] } },
    { answers: { services: [{ kind: "Nusxa", people: 5, cash: 75000 }, { people: 1, cash: 10000 }] } },
    { answers: {} },
  ];
  const [s] = summarize(SERVICES, reports);
  assert.equal(s.answered, 2);
  assert.equal(s.rows, 4);
  assert.deepEqual(s.columns.map((c) => [c.id, c.total]), [["people", 11], ["cash", 430000]]);
  assert.deepEqual(s.groups, [
    { name: "Nusxa", rows: 2, totals: { people: 8, cash: 120000 } },
    { name: "Tarjima", rows: 1, totals: { people: 2, cash: 300000 } },
    { name: null, rows: 1, totals: { people: 1, cash: 10000 } },
  ]);
});
