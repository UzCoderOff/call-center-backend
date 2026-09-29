const { phoneKey } = require("../lib/phone");
const { isValidDate } = require("../lib/firmTime");

// The clients database, as pure rules (tested in test/clients.test.js).
//
// A case ("ish") moves along two tracks, as in the firm's spreadsheet:
//   status      the operator's side: consultation -> call again -> contract,
//               or done / declined
//   legalStage  once there's a contract: where the case stands with the
//               investigators and courts
// Operators' monthly targets count consultations and contracts by the date
// the case first reached them (consultationDate / contractDate).

const STATUSES = ["consultation", "call_again", "contract", "done", "declined"];
const OPEN_STATUSES = ["consultation", "call_again", "contract"];
const LEGAL_STAGES = [
  "inquiry",
  "investigation",
  "sent_to_court",
  "first_instance",
  "appeal",
  "cassation",
  "review",
  "supreme_review",
];
const SOURCES = ["call", "telegram", "instagram", "referral", "walk_in", "other"];
const LINK_KINDS = ["family", "referral", "same_case", "work", "other"];
const PAYMENT_METHODS = ["cash", "card", "transfer"];
const PAYMENT_KINDS = ["consultation", "contract", "other"];
const MAX_PHONES = 5;

class ClientError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function text(value, max = 300) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function oneOf(value, list, field) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (!list.includes(value)) throw new ClientError(`invalid ${field}`);
  return value;
}

function date(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (!isValidDate(value)) throw new ClientError(`invalid ${field}`);
  return value;
}

const MAX_AMOUNT = 2147483647;

function amount(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = Number(value);
  // The database keeps amounts as 32-bit numbers: up to 2 147 483 647 soʻm.
  if (!Number.isInteger(n) || n < 0 || n > MAX_AMOUNT) throw new ClientError(`invalid ${field}`);
  return n;
}

// Phone numbers as typed, de-duplicated by their matching key.
function normalizePhones(input) {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw new ClientError("phones must be a list");
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const phone = String(raw ?? "").trim().slice(0, 40);
    if (!phone) continue;
    const key = phoneKey(phone);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push({ phone, phoneKey: key });
  }
  if (out.length > MAX_PHONES) throw new ClientError("too many phone numbers");
  return out;
}

// Uzbek Cyrillic -> Latin, lowercase, apostrophes and punctuation removed —
// so "Абдуллаев" and "Abdullaev", "Ғулом" and "G'ulom" meet in search.
// Only ever compared with itself (index and query go through it alike).
const CYR = {
  а: "a", б: "b", в: "v", г: "g", ғ: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "y",
  к: "k", қ: "q", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ў: "o",
  ф: "f", х: "x", ҳ: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sh", ъ: "", ы: "i", ь: "", э: "e", ю: "yu",
  я: "ya",
};

function searchable(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[а-яёғқўҳ]/g, (ch) => CYR[ch] ?? ch)
    .replace(/[ʻʼ'`‘’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    // People spell Х as x, h or kh ("Xaqqulov", "Haqqulov", "Khaqqulov"):
    // search treats them as one letter.
    .replace(/kh/g, "x")
    .replace(/h/g, "x")
    // Ц is written ts or s ("instantsiya", "instansiya").
    .replace(/ts/g, "s")
    .trim();
}

// Everything a client can be found by, in one searchable string.
function buildSearchText({ name, city, phones = [], caseNumbers = [] }) {
  const digits = phones.map((p) => String(p).replace(/\D/g, "")).filter(Boolean);
  return [searchable(name), searchable(city), ...digits, ...caseNumbers.map(searchable)].filter(Boolean).join(" ");
}

// Validates a case change. Moving the status forward stamps the date the
// case first reached a consultation / a contract (what the targets count).
function normalizeCase(input, current = {}, today) {
  const data = {};
  const set = (key, value) => {
    if (value !== undefined) data[key] = value;
  };
  set("matter", text(input.matter, 500));
  set("number", text(input.number, 80));
  set("lawyer", text(input.lawyer, 120));
  set("status", oneOf(input.status, STATUSES, "status") ?? undefined);
  set("legalStage", oneOf(input.legalStage, LEGAL_STAGES, "legalStage"));
  set("startDate", date(input.startDate, "startDate"));
  set("consultationDate", date(input.consultationDate, "consultationDate"));
  set("contractDate", date(input.contractDate, "contractDate"));
  set("contractAmount", amount(input.contractAmount, "contractAmount"));

  // A new case starts today unless told otherwise.
  if (!current.id && !data.startDate) data.startDate = today;

  // "Call again" isn't a consultation yet; a contract implies there was one.
  const status = data.status ?? current.status ?? "consultation";
  const start = data.startDate ?? current.startDate ?? today;
  if (COUNTS_AS_CONSULTATION.includes(status) && !current.consultationDate && !data.consultationDate) {
    data.consultationDate = start;
  }
  if (COUNTS_AS_CONTRACT.includes(status) && !current.contractDate && !data.contractDate) {
    data.contractDate = today;
  }
  return data;
}

const COUNTS_AS_CONSULTATION = ["consultation", "contract", "done"];
const COUNTS_AS_CONTRACT = ["contract", "done"];

// Money for one case: contract amount, paid so far, what's left.
function paymentSummary(contractAmount, payments) {
  const paid = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  // No contract amount: nothing to compare against — no "fully paid" claim.
  if (!contractAmount) return { paid, remaining: 0, state: "none" };
  const remaining = Math.max(0, contractAmount - paid);
  return { paid, remaining, state: remaining === 0 ? "paid" : paid > 0 ? "partial" : "unpaid" };
}

function normalizePayment(input) {
  const value = amount(input.amount, "amount");
  if (!value) throw new ClientError("amount is required");
  const day = date(input.date, "date");
  if (!day) throw new ClientError("date is required");
  return {
    amount: value,
    date: day,
    method: oneOf(input.method, PAYMENT_METHODS, "method"),
    kind: oneOf(input.kind, PAYMENT_KINDS, "kind") || "contract",
    note: text(input.note, 300),
  };
}

module.exports = {
  STATUSES,
  OPEN_STATUSES,
  LEGAL_STAGES,
  SOURCES,
  LINK_KINDS,
  PAYMENT_METHODS,
  PAYMENT_KINDS,
  MAX_PHONES,
  ClientError,
  text,
  oneOf,
  date,
  amount,
  normalizePhones,
  searchable,
  buildSearchText,
  normalizeCase,
  paymentSummary,
  normalizePayment,
};
