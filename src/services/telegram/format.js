const env = require("../../config/env");
const { shiftDate, isoWeekday, firmNow } = require("../../lib/firmTime");

// Words and formats for the bot's messages — in Uzbek, like the portal.
// Spelling as in the portal: oʻ / gʻ with U+02BB, the tutuq belgisi U+02BC.

const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
const WEEKDAYS = ["dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba", "yakshanba"];

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 630 -> "10:30"
function clock(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// "2026-09-30" -> "30-sentabr, chorshanba"
function day(dateStr) {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${d}-${MONTHS[m - 1]}, ${WEEKDAYS[isoWeekday(dateStr) - 1]}`;
}

// "Bugun" / "Ertaga" / "30-sentabr, chorshanba", relative to `today`.
function relativeDay(dateStr, today) {
  if (dateStr === today) return "Bugun";
  if (dateStr === shiftDate(today, 1)) return "Ertaga";
  return day(dateStr);
}

// A moment in the firm's time: "Bugun, 14:00" / "Ertaga, 09:30" /
// "2-oktabr, payshanba, 10:00".
function moment(when, today) {
  const at = firmNow(when instanceof Date ? when : new Date(when));
  return `${relativeDay(at.date, today || firmNow().date)}, ${clock(at.minutes)}`;
}

// "+998 90 123 45 67" for Uzbek mobile numbers; anything else as it came.
function phone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("998")) {
    return `+998 ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8, 10)} ${digits.slice(10)}`;
  }
  if (digits.length === 9) return `+998 ${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 7)} ${digits.slice(7)}`;
  return String(value || "");
}

// "+998901234567" — the form Telegram recognises as a phone number (tap to
// call).
function phoneCompact(value) {
  return phone(value).replace(/\s/g, "");
}

// 1500000 -> "1 500 000 soʻm"
function money(amount) {
  return `${String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} soʻm`;
}

// A link into the portal, when PORTAL_URL is set.
function portalLink(pathname, label = "Ledgerda ochish") {
  if (!env.portalUrl) return "";
  return `<a href="${escapeHtml(env.portalUrl + pathname)}">${escapeHtml(label)}</a>`;
}

const personName = (user) => user?.employee?.name || user?.name || user?.username || "";

module.exports = { escapeHtml, clock, day, relativeDay, moment, phone, phoneCompact, money, portalLink, personName, MONTHS, WEEKDAYS };
