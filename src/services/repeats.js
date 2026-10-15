const { isValidDate, isoWeekday, shiftDate } = require("../lib/firmTime");

// Repeating events in a lawyer's own calendar (PersonalEvent.repeat,
// 2026-10-15): kept once, shown on each day of the series.
//   daily     every day
//   workdays  Monday–Saturday (the firm's week)
//   weekly    the same weekday as the first one
// From the event's date to repeatUntil (null: no end), less skipDates (days
// taken out one by one: "only this day" when deleting).

const REPEATS = ["daily", "workdays", "weekly"];
const MAX_SPAN_DAYS = 400;

const onDay = (repeat, first, day) => {
  if (day < first) return false;
  if (repeat === "daily") return true;
  if (repeat === "workdays") return isoWeekday(day) <= 6;
  if (repeat === "weekly") return isoWeekday(day) === isoWeekday(first);
  return day === first;
};

// The days in from..to an event falls on.
function occurrences(event, from, to) {
  if (!event.repeat) return event.date >= from && event.date <= to ? [event.date] : [];
  const skip = new Set(Array.isArray(event.skipDates) ? event.skipDates : []);
  const end = event.repeatUntil && event.repeatUntil < to ? event.repeatUntil : to;
  const out = [];
  for (let d = event.date > from ? event.date : from; d <= end; d = shiftDate(d, 1)) {
    if (onDay(event.repeat, event.date, d) && !skip.has(d)) out.push(d);
  }
  return out;
}

// A `where` for the events that may fall in from..to: on a day in it, or a
// series that started by then and hasn't ended before it.
const rangeWhere = (from, to) => ({
  OR: [{ date: { gte: from, lte: to } }, { repeat: { not: null }, date: { lte: to }, OR: [{ repeatUntil: null }, { repeatUntil: { gte: from } }] }],
});

// { repeat, repeatUntil } from a request (undefined: not sent); `date`: the
// series' first day.
function repeatFields(b, date) {
  const out = {};
  if (b.repeat !== undefined) {
    if (b.repeat === null || b.repeat === "" || b.repeat === "none") out.repeat = null;
    else if (REPEATS.includes(b.repeat)) out.repeat = b.repeat;
    else throw Object.assign(new Error("invalid repeat"), { status: 400 });
  }
  if (b.repeatUntil !== undefined) {
    if (b.repeatUntil === null || b.repeatUntil === "") out.repeatUntil = null;
    else if (!isValidDate(b.repeatUntil) || (date && b.repeatUntil < date) || (date && b.repeatUntil > shiftDate(date, MAX_SPAN_DAYS))) {
      throw Object.assign(new Error("invalid repeatUntil"), { status: 400 });
    } else out.repeatUntil = b.repeatUntil;
  }
  if (out.repeat === null) out.repeatUntil = null;
  return out;
}

module.exports = { REPEATS, occurrences, rangeWhere, repeatFields, onDay };
