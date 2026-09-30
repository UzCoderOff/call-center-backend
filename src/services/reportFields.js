const crypto = require("crypto");

// Daily report forms are built in the portal, so their questions are data,
// not code. A form's `fields` is an ordered list of:
//
//   { id, label, type, required, options?, hint? }
//
// Types:
//   text      short answer            -> string
//   textarea  long answer             -> string
//   number    a count                 -> number
//   money     an amount in soʻm       -> whole number >= 0
//   yesno     yes / no                -> boolean
//   select    one of `options`        -> string
//   checklist any of `options`        -> string[]
//   table     rows the person adds, like a small Excel sheet, with the
//             form's `columns`: [{ id, label, type, options? }] (column
//             types: text, number, money, select) -> [{ colId: value }]
//             e.g. Service | People served | Income | Note
//
// Adding a type means: add it here (validation + summary) and to the
// portal's field editor and form renderer. Nothing in the database changes.
//
// A money question (or money column) can also say how the Moliya page counts
// it: `finance: "income"` (money the firm received — e.g. translation fees)
// or "expense" (money spent — taxi, stamps). Without it the amount isn't
// counted: it may already be in Ledger as a client payment. The developer
// sets it in the form editor (services/reportMoney.js adds it up).

const FIELD_TYPES = ["text", "textarea", "number", "money", "yesno", "select", "checklist", "table"];
const COLUMN_TYPES = ["text", "number", "money", "select"];
const NUMERIC_TYPES = ["number", "money"];
const OPTION_TYPES = ["select", "checklist"];
const FINANCE_KINDS = ["income", "expense"];

const MAX_FIELDS = 40;
const MAX_OPTIONS = 30;
const MAX_COLUMNS = 10;
const MAX_ROWS = 100;
const MAX_TEXT = { text: 500, textarea: 5000 };

class FieldError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function cleanText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanOptions(raw, where) {
  const options = [...new Set((Array.isArray(raw) ? raw : []).map((o) => cleanText(o, 100)).filter(Boolean))];
  if (options.length === 0) throw new FieldError(`${where} needs at least one option`);
  if (options.length > MAX_OPTIONS) throw new FieldError(`${where} has too many options`);
  return options;
}

// A table question's columns: ids kept (answers are stored by them), labels
// and types checked.
function normalizeColumns(raw, where) {
  if (!Array.isArray(raw) || raw.length === 0) throw new FieldError(`${where} needs at least one column`);
  if (raw.length > MAX_COLUMNS) throw new FieldError(`${where} can have at most ${MAX_COLUMNS} columns`);
  const seen = new Set();
  return raw.map((c, j) => {
    const label = cleanText(c?.label, 100);
    if (!label) throw new FieldError(`${where}, column ${j + 1} has no name`);
    if (!COLUMN_TYPES.includes(c?.type)) throw new FieldError(`${where}, column ${j + 1} has an unknown type`);
    let id = typeof c.id === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(c.id) ? c.id : null;
    if (!id || seen.has(id)) id = `c_${crypto.randomBytes(4).toString("hex")}`;
    seen.add(id);
    const column = { id, label, type: c.type };
    if (c.type === "select") column.options = cleanOptions(c.options, `${where}, column ${j + 1}`);
    if (c.type === "money" && FINANCE_KINDS.includes(c.finance)) column.finance = c.finance;
    return column;
  });
}

// One cell of a table row: a clean value, or undefined if empty/invalid
// (`bad` is set for invalid).
function cellValue(column, value) {
  if (value === undefined || value === null || String(value).trim() === "") return { value: undefined };
  switch (column.type) {
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
      return Number.isFinite(n) ? { value: n } : { bad: true };
    }
    case "money": {
      const n = typeof value === "number" ? value : Number(String(value).replace(/[\s ]/g, ""));
      return Number.isFinite(n) && n >= 0 ? { value: Math.round(n) } : { bad: true };
    }
    case "select":
      return column.options.includes(value) ? { value } : { bad: true };
    default:
      return typeof value === "string" ? { value: value.trim().slice(0, MAX_TEXT.text) } : { bad: true };
  }
}

// Validates and normalises a form definition coming from the portal.
// Throws FieldError (-> 400) with a readable message on bad input.
function normalizeFields(input) {
  if (!Array.isArray(input) || input.length === 0) throw new FieldError("a form needs at least one question");
  if (input.length > MAX_FIELDS) throw new FieldError(`a form can have at most ${MAX_FIELDS} questions`);

  const seen = new Set();
  return input.map((raw, i) => {
    const label = cleanText(raw?.label, 200);
    if (!label) throw new FieldError(`question ${i + 1} has no text`);
    if (!FIELD_TYPES.includes(raw?.type)) throw new FieldError(`question ${i + 1} has an unknown type`);

    let id = typeof raw.id === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(raw.id) ? raw.id : null;
    if (!id || seen.has(id)) id = `f_${crypto.randomBytes(5).toString("hex")}`;
    seen.add(id);

    const field = { id, label, type: raw.type, required: Boolean(raw.required) };
    const hint = cleanText(raw.hint, 200);
    if (hint) field.hint = hint;

    if (OPTION_TYPES.includes(raw.type)) field.options = cleanOptions(raw.options, `question ${i + 1}`);
    if (raw.type === "table") field.columns = normalizeColumns(raw.columns, `question ${i + 1}`);
    if (raw.type === "money" && FINANCE_KINDS.includes(raw.finance)) field.finance = raw.finance;
    return field;
  });
}

function isEmpty(field, value) {
  if (value === undefined || value === null) return true;
  if (field.type === "yesno") return typeof value !== "boolean";
  if (field.type === "checklist") return !Array.isArray(value) || value.length === 0;
  if (field.type === "table") return !Array.isArray(value) || !value.some((row) => row && Object.values(row).some((v) => String(v ?? "").trim() !== ""));
  if (typeof value === "string") return value.trim() === "";
  return false;
}

// Checks one person's answers against the form. Returns { answers, errors }
// where `answers` keeps only valid values for known questions and `errors`
// maps field id -> "required" | "invalid".
function validateAnswers(fields, input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const answers = {};
  const errors = {};

  for (const field of fields) {
    const value = source[field.id];

    if (isEmpty(field, value)) {
      if (field.required) errors[field.id] = "required";
      continue;
    }

    switch (field.type) {
      case "text":
      case "textarea":
        if (typeof value !== "string") errors[field.id] = "invalid";
        else answers[field.id] = value.trim().slice(0, MAX_TEXT[field.type]);
        break;
      case "number": {
        const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
        if (!Number.isFinite(n)) errors[field.id] = "invalid";
        else answers[field.id] = n;
        break;
      }
      case "money": {
        const n = typeof value === "number" ? value : Number(String(value).replace(/[\s ]/g, ""));
        if (!Number.isFinite(n) || n < 0) errors[field.id] = "invalid";
        else answers[field.id] = Math.round(n);
        break;
      }
      case "yesno":
        answers[field.id] = value;
        break;
      case "select":
        if (!field.options.includes(value)) errors[field.id] = "invalid";
        else answers[field.id] = value;
        break;
      case "checklist": {
        const picked = value.filter((v) => field.options.includes(v));
        if (picked.length !== value.length) errors[field.id] = "invalid";
        else answers[field.id] = [...new Set(picked)];
        break;
      }
      case "table": {
        // Rows with nothing filled in are dropped; any cell that doesn't fit
        // its column makes the question invalid (nothing is silently lost).
        const rows = [];
        let bad = false;
        for (const raw of value.slice(0, MAX_ROWS)) {
          if (!raw || typeof raw !== "object") continue;
          const row = {};
          for (const column of field.columns) {
            const cell = cellValue(column, raw[column.id]);
            if (cell.bad) bad = true;
            else if (cell.value !== undefined) row[column.id] = cell.value;
          }
          if (Object.keys(row).length > 0) rows.push(row);
        }
        if (bad) errors[field.id] = "invalid";
        else if (rows.length === 0) {
          if (field.required) errors[field.id] = "required";
        } else answers[field.id] = rows;
        break;
      }
      default:
        break;
    }
  }

  return { answers, errors };
}

// Per-question totals across several reports of the same form — what the
// boss sees for a day: "42 documents translated, 1 250 000 soʻm received,
// 5 of 6 said yes".
function summarize(fields, reports) {
  return fields
    .filter((f) => f.type !== "text" && f.type !== "textarea")
    .map((field) => {
      const values = reports.map((r) => r.answers?.[field.id]).filter((v) => v !== undefined && v !== null);
      const summary = { id: field.id, label: field.label, type: field.type, answered: values.length };
      if (field.type === "table") {
        Object.assign(summary, tableTotals(field, values.flat()));
      } else if (NUMERIC_TYPES.includes(field.type)) {
        summary.total = values.reduce((sum, v) => sum + (Number(v) || 0), 0);
      } else if (field.type === "yesno") {
        summary.yes = values.filter((v) => v === true).length;
      } else {
        summary.counts = Object.fromEntries(field.options.map((o) => [o, 0]));
        for (const v of values) {
          for (const choice of Array.isArray(v) ? v : [v]) {
            if (choice in summary.counts) summary.counts[choice] += 1;
          }
        }
      }
      return summary;
    });
}

// A table question's rows added up: the totals of its number/money columns,
// and — by its first choice (or text) column, e.g. "Service" — how many rows
// and what totals each kind has: "Tarjima: 12 rows, 34 people, 1 200 000".
function tableTotals(field, rows) {
  const numeric = field.columns.filter((c) => NUMERIC_TYPES.includes(c.type));
  const sum = (list, id) => list.reduce((s, r) => s + (Number(r[id]) || 0), 0);
  const by = field.columns.find((c) => c.type === "select") || field.columns.find((c) => c.type === "text");
  const out = {
    rows: rows.length,
    columns: numeric.map((c) => ({ id: c.id, label: c.label, type: c.type, total: sum(rows, c.id) })),
    groups: [],
  };
  if (by) {
    const groups = new Map();
    for (const row of rows) {
      const raw = row[by.id];
      const name = typeof raw === "string" && raw.trim() ? raw.trim() : null;
      const key = name ? name.toLowerCase() : "";
      if (!groups.has(key)) groups.set(key, { name, rows: [] });
      groups.get(key).rows.push(row);
    }
    // Choices in the order they were set up, then anything typed, then blanks.
    const order = (g) => (by.options ? (g.name && by.options.includes(g.name) ? by.options.indexOf(g.name) : 1000) : 0) + (g.name ? 0 : 2000);
    out.by = { id: by.id, label: by.label };
    out.groups = [...groups.values()]
      .sort((a, b) => order(a) - order(b) || (b.rows.length - a.rows.length))
      .map((g) => ({ name: g.name, rows: g.rows.length, totals: Object.fromEntries(numeric.map((c) => [c.id, sum(g.rows, c.id)])) }));
  }
  return out;
}

module.exports = { FIELD_TYPES, COLUMN_TYPES, FINANCE_KINDS, FieldError, normalizeFields, validateAnswers, summarize, tableTotals };
