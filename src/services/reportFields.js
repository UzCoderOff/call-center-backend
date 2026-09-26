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
//
// Adding a type means: add it here (validation + summary) and to the
// portal's field editor and form renderer. Nothing in the database changes.

const FIELD_TYPES = ["text", "textarea", "number", "money", "yesno", "select", "checklist"];
const NUMERIC_TYPES = ["number", "money"];
const OPTION_TYPES = ["select", "checklist"];

const MAX_FIELDS = 40;
const MAX_OPTIONS = 30;
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

    if (OPTION_TYPES.includes(raw.type)) {
      const options = [...new Set((Array.isArray(raw.options) ? raw.options : []).map((o) => cleanText(o, 100)).filter(Boolean))];
      if (options.length === 0) throw new FieldError(`question ${i + 1} needs at least one option`);
      if (options.length > MAX_OPTIONS) throw new FieldError(`question ${i + 1} has too many options`);
      field.options = options;
    }
    return field;
  });
}

function isEmpty(field, value) {
  if (value === undefined || value === null) return true;
  if (field.type === "yesno") return typeof value !== "boolean";
  if (field.type === "checklist") return !Array.isArray(value) || value.length === 0;
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
      if (NUMERIC_TYPES.includes(field.type)) {
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

module.exports = { FIELD_TYPES, FieldError, normalizeFields, validateAnswers, summarize };
