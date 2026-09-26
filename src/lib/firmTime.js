const env = require("../config/env");

// Calendar days in the firm's timezone. A daily report "for 26 September"
// means 26 September in Tashkent, whatever timezone the VPS runs in.

const DAY_MS = 24 * 60 * 60 * 1000;

function partsIn(timeZone, date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), s: get("second") };
}

// "YYYY-MM-DD" for the given moment (default: now) in the firm's timezone.
function firmDate(date = new Date(), timeZone = env.firmTimezone) {
  const { y, m, d } = partsIn(timeZone, date);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

// Epoch-ms bounds of that calendar day in the firm's timezone.
function firmDayRange(dateStr, timeZone = env.firmTimezone) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  // Offset of the timezone at (roughly) that moment.
  const p = partsIn(timeZone, new Date(utcMidnight));
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - utcMidnight;
  const from = utcMidnight - offset;
  return { from, to: from + DAY_MS - 1 };
}

function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return t.toISOString().slice(0, 10);
}

// Today's date and the minutes since midnight, in the firm's timezone —
// "is this appointment slot already in the past?"
function firmNow(date = new Date(), timeZone = env.firmTimezone) {
  const p = partsIn(timeZone, date);
  return { date: firmDate(date, timeZone), minutes: p.h * 60 + p.min };
}

// 1 = Monday … 7 = Sunday, for a "YYYY-MM-DD".
function isoWeekday(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

// The Monday of the week containing dateStr.
function weekStartOf(dateStr) {
  return shiftDate(dateStr, 1 - isoWeekday(dateStr));
}

module.exports = { firmDate, firmDayRange, isValidDate, shiftDate, firmNow, isoWeekday, weekStartOf };
