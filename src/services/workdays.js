const prisma = require("../lib/prisma");
const { firmDate, isoWeekday, isValidDate, shiftDate } = require("../lib/firmTime");

// Who works when.
//
// Each person has a weekly pattern (Employee.workDays — "123456" is
// Monday–Saturday; call-center staff, working from their own phone, usually
// "1234567") and whether public holidays are days off for them
// (Employee.holidaysOff — office staff yes, call center usually not). On top
// come their approved days away (Absence): a day off, sick, a vacation — not
// working days — or "remote": worked, just not at the office.
//
// Public holidays: the fixed-date ones below are *suggested* for this year
// and next, and count only once the developer confirms them (dates move by
// decree, extra days get added). The movable ones — Ramazon hayiti, Qurbon
// hayiti — are announced each year and added by hand.
//
// Used by: the performance page (targets and "by today" spread over their
// real working days; reports due only on those), the reports-of-the-day view
// and the Telegram report reminder (nobody is chased on a day off).

const FIXED_HOLIDAYS = [
  ["01-01", "Yangi yil"],
  ["03-08", "Xalqaro xotin-qizlar kuni"],
  ["03-21", "Navroʻz bayrami"],
  ["05-09", "Xotira va qadrlash kuni"],
  ["09-01", "Mustaqillik kuni"],
  ["10-01", "Oʻqituvchi va murabbiylar kuni"],
  ["12-08", "Konstitutsiya kuni"],
  ["12-31", "Yangi yil arafasi (odatda qoʻshimcha dam olish kuni)"],
];
const ABSENCE_KINDS = ["day_off", "sick", "vacation", "remote"];
// Kinds that make it not a working day ("remote" is still one).
const AWAY_KINDS = ["day_off", "sick", "vacation"];
const DEFAULT_PATTERN = "123456";

const isBuiltinDate = (date) => FIXED_HOLIDAYS.some(([md]) => date.slice(5) === md);

// "123456" etc.: digits 1–7, each once, at least one.
function normalizePattern(value) {
  if (typeof value !== "string") return null;
  const digits = [...new Set(value.split("").filter((c) => /[1-7]/.test(c)))].sort();
  return digits.length ? digits.join("") : null;
}

// The suggestions for these years, added once each (a date the developer
// rejected stays rejected).
async function ensureSuggestions(years, db = prisma) {
  const wanted = years.flatMap((y) => FIXED_HOLIDAYS.map(([md, name]) => ({ date: `${y}-${md}`, name })));
  const existing = new Set((await db.holiday.findMany({ where: { date: { in: wanted.map((w) => w.date) } }, select: { date: true } })).map((h) => h.date));
  for (const w of wanted) {
    if (existing.has(w.date)) continue;
    try {
      await db.holiday.create({ data: { date: w.date, name: w.name, status: "suggested" } });
    } catch {
      // Created meanwhile by another request.
    }
  }
}

// Confirmed holidays between two dates: date -> name.
async function confirmedHolidays(from, to, db = prisma) {
  const rows = await db.holiday.findMany({ where: { status: "confirmed", date: { gte: from, lte: to } }, select: { date: true, name: true } });
  return new Map(rows.map((h) => [h.date, h.name]));
}

// Approved days away overlapping [from, to], by employee id.
async function approvedAbsences(employeeIds, from, to, db = prisma) {
  const rows = await db.absence.findMany({
    where: { employeeId: { in: employeeIds }, status: "approved", from: { lte: to }, to: { gte: from } },
    select: { employeeId: true, from: true, to: true, kind: true },
  });
  const map = new Map();
  for (const r of rows) map.set(r.employeeId, [...(map.get(r.employeeId) || []), r]);
  return map;
}

// Why `date` isn't a working day for this person, or null if it is.
// employee: { workDays, holidaysOff }; holidays: Map date -> name;
// absences: their approved ones.
function offReason(date, employee, holidays, absences = []) {
  const pattern = employee.workDays || DEFAULT_PATTERN;
  const away = absences.find((a) => a.from <= date && date <= a.to && AWAY_KINDS.includes(a.kind));
  if (away) return { kind: away.kind };
  if (!pattern.includes(String(isoWeekday(date)))) return { kind: "weekly" };
  if (employee.holidaysOff !== false && holidays.has(date)) return { kind: "holiday", name: holidays.get(date) };
  return null;
}

function datesBetween(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length < 400; d = shiftDate(d, 1)) out.push(d);
  return out;
}

// For several people over a span: each one's working dates, and why the
// other dates aren't. employees: [{ id, workDays, holidaysOff }].
async function workingDates(employees, from, to, db = prisma) {
  const [holidays, absences] = await Promise.all([confirmedHolidays(from, to, db), approvedAbsences(employees.map((e) => e.id), from, to, db)]);
  const dates = datesBetween(from, to);
  const map = new Map();
  for (const e of employees) {
    const mine = absences.get(e.id) || [];
    const work = [];
    const off = [];
    for (const d of dates) {
      const reason = offReason(d, e, holidays, mine);
      if (reason) off.push({ date: d, ...reason });
      else work.push(d);
    }
    map.set(e.id, { work, off });
  }
  return { byEmployee: map, holidays };
}

// Is today (or `date`) a working day for this one person?
async function worksOn(employee, date = firmDate(), db = prisma) {
  const { byEmployee } = await workingDates([employee], date, date, db);
  return byEmployee.get(employee.id).work.length === 1;
}

// Checks a days-away request: dates in order, at most 92 days, a known kind.
function checkAbsence(b) {
  if (!isValidDate(b.from) || !isValidDate(b.to)) return "invalid dates";
  if (b.from > b.to) return "from is after to";
  if (datesBetween(b.from, b.to).length > 92) return "at most 92 days";
  if (!ABSENCE_KINDS.includes(b.kind)) return "invalid kind";
  return null;
}

module.exports = {
  FIXED_HOLIDAYS,
  ABSENCE_KINDS,
  AWAY_KINDS,
  DEFAULT_PATTERN,
  isBuiltinDate,
  normalizePattern,
  ensureSuggestions,
  confirmedHolidays,
  approvedAbsences,
  offReason,
  workingDates,
  worksOn,
  checkAbsence,
  datesBetween,
};
