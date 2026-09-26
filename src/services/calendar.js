const { isValidDate, shiftDate } = require("../lib/firmTime");

// The lawyer's calendar, as pure functions (tested in test/calendar.test.js).
//
// A week's plan is a list of blocks: { date, start, end, kind, note? } with
// start/end in minutes from midnight (firm timezone) and kind:
//   "available" — reception: staff can book clients into it
//   "busy"      — court, a trip, a meeting… (the note is shown to staff)
//   "break"     — lunch or another break
// Appointments are { date, start, end, status }; cancelled ones free their time.
//
// Every new week starts from the calendar's usual week (its settings:
// working days, hours, lunch), and the lawyer changes any day from there.

const KINDS = ["available", "busy", "break"];
const MIN_BLOCK = 15;
const MAX_BLOCKS = 200;
const DAY = 24 * 60;
const SLOT_MINUTES = [15, 20, 30, 45, 60, 90, 120];

class CalendarError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function isMinute(v) {
  return Number.isInteger(v) && v >= 0 && v <= DAY;
}

function cleanNote(note) {
  return typeof note === "string" && note.trim() ? note.trim().slice(0, 200) : undefined;
}

// Validates a week's blocks: dates inside the week, sane times, no
// overlaps within a day. Returns them sorted.
function normalizeBlocks(input, weekStart) {
  if (!Array.isArray(input)) throw new CalendarError("blocks must be a list");
  if (input.length > MAX_BLOCKS) throw new CalendarError("too many time blocks");
  const weekDates = new Set(Array.from({ length: 7 }, (_, i) => shiftDate(weekStart, i)));

  const blocks = input.map((raw, i) => {
    if (!raw || !isValidDate(raw.date) || !weekDates.has(raw.date)) {
      throw new CalendarError(`block ${i + 1}: date is not in this week`);
    }
    if (!isMinute(raw.start) || !isMinute(raw.end) || raw.end - raw.start < MIN_BLOCK) {
      throw new CalendarError(`block ${i + 1}: invalid time range`);
    }
    if (!KINDS.includes(raw.kind)) throw new CalendarError(`block ${i + 1}: unknown kind`);
    const block = { date: raw.date, start: raw.start, end: raw.end, kind: raw.kind };
    const note = cleanNote(raw.note);
    if (note) block.note = note;
    return block;
  });

  blocks.sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].date === blocks[i - 1].date && blocks[i].start < blocks[i - 1].end) {
      throw new CalendarError(`time blocks overlap on ${blocks[i].date}`);
    }
  }
  return blocks;
}

// ---------------------------------------------------------- the usual week

function parseWorkDays(value) {
  return String(value || "")
    .split(",")
    .filter(Boolean)
    .map(Number)
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
}

// The calendar's settings as the API shows them.
function usualWeekOf(calendar) {
  return {
    workDays: parseWorkDays(calendar.workDays),
    dayStart: calendar.dayStart,
    dayEnd: calendar.dayEnd,
    lunch: calendar.lunchStart == null ? null : { start: calendar.lunchStart, end: calendar.lunchEnd },
    slotMinutes: calendar.slotMinutes,
  };
}

// Validates a change to the usual week (any subset of workDays, dayStart,
// dayEnd, lunch, slotMinutes) and returns the database columns to update.
function normalizeUsualWeek(input, current) {
  const next = usualWeekOf(current);
  const data = {};
  if (input.workDays !== undefined) {
    if (!Array.isArray(input.workDays) || input.workDays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      throw new CalendarError("workDays must be weekdays 1-7");
    }
    next.workDays = [...new Set(input.workDays)].sort((a, b) => a - b);
    data.workDays = next.workDays.join(",");
  }
  if (input.dayStart !== undefined) next.dayStart = input.dayStart;
  if (input.dayEnd !== undefined) next.dayEnd = input.dayEnd;
  if (!isMinute(next.dayStart) || !isMinute(next.dayEnd) || next.dayEnd - next.dayStart < MIN_BLOCK) {
    throw new CalendarError("invalid working hours");
  }
  data.dayStart = next.dayStart;
  data.dayEnd = next.dayEnd;
  if (input.lunch !== undefined) next.lunch = input.lunch;
  if (next.lunch) {
    const { start, end } = next.lunch;
    if (!isMinute(start) || !isMinute(end) || end - start < MIN_BLOCK) throw new CalendarError("invalid lunch time");
    if (start < next.dayStart || end > next.dayEnd) throw new CalendarError("lunch must be within working hours");
  }
  data.lunchStart = next.lunch ? next.lunch.start : null;
  data.lunchEnd = next.lunch ? next.lunch.end : null;
  if (input.slotMinutes !== undefined) {
    if (!SLOT_MINUTES.includes(input.slotMinutes)) throw new CalendarError("invalid slotMinutes");
    data.slotMinutes = input.slotMinutes;
  }
  return data;
}

// One ordinary working day: reception around the lunch break.
function usualDay(usual, date) {
  const { dayStart, dayEnd, lunch } = usual;
  if (!lunch) return [{ date, start: dayStart, end: dayEnd, kind: "available" }];
  return [
    { date, start: dayStart, end: lunch.start, kind: "available" },
    { date, start: lunch.start, end: lunch.end, kind: "break", note: "Tushlik" },
    { date, start: lunch.end, end: dayEnd, kind: "available" },
  ].filter((b) => b.end - b.start >= MIN_BLOCK);
}

// A new week, filled in from the usual week.
function usualWeekBlocks(usual, weekStart) {
  return usual.workDays.flatMap((weekday) => usualDay(usual, shiftDate(weekStart, weekday - 1)));
}

// ------------------------------------------------------------- bookings

const isActive = (a) => a.status !== "cancelled";
const overlaps = (a, b) => a.date === b.date && a.start < b.end && b.start < a.end;

// Is [start, end) on `date` entirely inside one "available" block?
function fitsAvailability(blocks, date, start, end) {
  return blocks.some((b) => b.kind === "available" && b.date === date && b.start <= start && end <= b.end);
}

// Bookable slots of `slotMinutes`, stepping through each available block,
// minus booked time and anything already in the past (`now` = firm-local
// { date, minutes }).
function freeSlots({ blocks, appointments, slotMinutes, now }) {
  const booked = appointments.filter(isActive);
  const slots = [];
  for (const b of blocks) {
    if (b.kind !== "available") continue;
    if (now && b.date < now.date) continue;
    for (let start = b.start; start + slotMinutes <= b.end; start += slotMinutes) {
      const slot = { date: b.date, start, end: start + slotMinutes };
      if (now && slot.date === now.date && slot.start <= now.minutes) continue;
      if (booked.some((a) => overlaps(a, slot))) continue;
      slots.push(slot);
    }
  }
  return slots;
}

// Active appointments that a new plan would leave outside reception time —
// the lawyer either keeps the old plan or cancels those appointments.
function conflictingAppointments(blocks, appointments) {
  return appointments.filter((a) => isActive(a) && !fitsAvailability(blocks, a.date, a.start, a.end));
}

module.exports = {
  KINDS,
  SLOT_MINUTES,
  CalendarError,
  normalizeBlocks,
  usualWeekOf,
  normalizeUsualWeek,
  usualDay,
  usualWeekBlocks,
  fitsAvailability,
  freeSlots,
  conflictingAppointments,
  overlaps,
  isActive,
};
