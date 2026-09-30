const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isManager } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { firmDate, isValidDate, shiftDate } = require("../lib/firmTime");
const w = require("../services/workdays");

// Holidays and days away (src/services/workdays.js).
//
//   GET    /api/holidays?year=            the year's holidays (the developer
//                                         also sees suggestions to confirm)
//   GET    /api/holidays/review           developer: suggestions coming up to confirm
//   POST   /api/holidays                  developer: { date, name } — a day off for everyone it applies to
//   PATCH  /api/holidays/:id              developer: { status: confirmed | rejected, name? }
//   DELETE /api/holidays/:id              developer
//
//   GET    /api/absences?from=&to=&status=  managers: everyone's; staff: their own
//   GET    /api/absences/summary          managers: requests waiting, who's away today
//   POST   /api/absences                  { from, to, kind, note?, employeeId? }
//                                         staff ask for themselves (waits for approval);
//                                         a manager adding one approves it at once
//   PATCH  /api/absences/:id              managers: { status: approved | rejected }
//   DELETE /api/absences/:id              managers; staff their own while it waits

const holidays = express.Router();
holidays.use(requireAuth);
const developerOnly = (req, res, next) => (req.user.role === "DEVELOPER" ? next() : res.status(403).json({ error: "forbidden" }));
const HOLIDAY_SELECT = { id: true, date: true, name: true, status: true, confirmedAt: true, confirmedBy: { select: { username: true, name: true } } };

holidays.get("/", async (req, res, next) => {
  try {
    const thisYear = Number(firmDate().slice(0, 4));
    const year = req.query.year ? Number(req.query.year) : thisYear;
    if (!Number.isInteger(year) || year < 2020 || year > 2100) throw badRequest("invalid year");
    await w.ensureSuggestions([thisYear, thisYear + 1]);
    const developer = req.user.role === "DEVELOPER";
    const rows = await prisma.holiday.findMany({
      where: { date: { gte: `${year}-01-01`, lte: `${year}-12-31` }, ...(developer ? {} : { status: "confirmed" }) },
      orderBy: { date: "asc" },
      select: HOLIDAY_SELECT,
    });
    res.json({ year, rows: rows.map((h) => ({ ...h, builtin: w.isBuiltinDate(h.date) })) });
  } catch (err) {
    next(err);
  }
});

// Suggestions in the next 60 days still waiting for the developer's word.
holidays.get("/review", developerOnly, async (req, res, next) => {
  try {
    const today = firmDate();
    const thisYear = Number(today.slice(0, 4));
    await w.ensureSuggestions([thisYear, thisYear + 1]);
    const soon = await prisma.holiday.findMany({
      where: { status: "suggested", date: { gte: today, lte: shiftDate(today, 60) } },
      orderBy: { date: "asc" },
      select: HOLIDAY_SELECT,
    });
    res.json({ today, soon });
  } catch (err) {
    next(err);
  }
});

holidays.post("/", developerOnly, async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!isValidDate(b.date)) throw badRequest("invalid date");
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 120) : "";
    if (!name) throw badRequest("name is required");
    const data = { name, status: "confirmed", confirmedById: req.user.id, confirmedAt: new Date() };
    const row = await prisma.holiday.upsert({ where: { date: b.date }, create: { date: b.date, ...data }, update: data, select: HOLIDAY_SELECT });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

holidays.patch("/:id", developerOnly, async (req, res, next) => {
  try {
    const b = req.body || {};
    const data = {};
    if (b.status !== undefined) {
      if (!["confirmed", "rejected"].includes(b.status)) throw badRequest("invalid status");
      Object.assign(data, { status: b.status, confirmedById: req.user.id, confirmedAt: new Date() });
    }
    if (b.name !== undefined) {
      const name = typeof b.name === "string" ? b.name.trim().slice(0, 120) : "";
      if (!name) throw badRequest("name is required");
      data.name = name;
    }
    const row = await prisma.holiday.update({ where: { id: parseId(req.params.id) }, data, select: HOLIDAY_SELECT });
    res.json(row);
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "not_found" });
    next(err);
  }
});

// A suggested date is kept as "rejected" (so it isn't suggested again);
// one added by hand is removed.
holidays.delete("/:id", developerOnly, async (req, res, next) => {
  try {
    const row = await prisma.holiday.findUnique({ where: { id: parseId(req.params.id) } });
    if (!row) return res.status(404).json({ error: "not_found" });
    if (w.isBuiltinDate(row.date)) await prisma.holiday.update({ where: { id: row.id }, data: { status: "rejected", confirmedById: req.user.id, confirmedAt: new Date() } });
    else await prisma.holiday.delete({ where: { id: row.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------ absences
const absences = express.Router();
absences.use(requireAuth);
const PERSON = { select: { id: true, username: true, name: true, employee: { select: { name: true } } } };
const ABSENCE_INCLUDE = { employee: { select: { id: true, name: true } }, requestedBy: PERSON, decidedBy: PERSON };
const personName = (u) => (u ? u.employee?.name || u.name || u.username : null);
const shape = (a) => ({
  id: a.id,
  employee: a.employee,
  from: a.from,
  to: a.to,
  days: w.datesBetween(a.from, a.to).length,
  kind: a.kind,
  note: a.note,
  status: a.status,
  requestedBy: personName(a.requestedBy),
  decidedBy: personName(a.decidedBy),
  decidedAt: a.decidedAt,
  createdAt: a.createdAt,
});

absences.get("/", async (req, res, next) => {
  try {
    const manager = isManager(req.user);
    if (!manager && !req.user.employee) return res.json([]);
    const where = {};
    if (!manager) where.employeeId = req.user.employee.id;
    else if (req.query.employeeId) where.employeeId = parseId(req.query.employeeId, "employeeId");
    if (req.query.status) {
      if (!["pending", "approved", "rejected"].includes(req.query.status)) throw badRequest("invalid status");
      where.status = req.query.status;
    }
    if (req.query.from || req.query.to) {
      const from = String(req.query.from || "2000-01-01");
      const to = String(req.query.to || "2100-12-31");
      if (!isValidDate(from) || !isValidDate(to)) throw badRequest("invalid dates");
      Object.assign(where, { from: { lte: to }, to: { gte: from } });
    }
    const rows = await prisma.absence.findMany({ where, include: ABSENCE_INCLUDE, orderBy: [{ from: "desc" }, { id: "desc" }], take: 300 });
    res.json(rows.map(shape));
  } catch (err) {
    next(err);
  }
});

// For the managers' home page: requests waiting, and who isn't working today.
absences.get("/summary", async (req, res, next) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    const today = firmDate();
    const [pending, employees] = await Promise.all([
      prisma.absence.count({ where: { status: "pending" } }),
      prisma.employee.findMany({ where: { active: true }, select: { id: true, name: true, workDays: true, holidaysOff: true } }),
    ]);
    const { byEmployee, holidays: hol } = await w.workingDates(employees, today, today);
    const away = employees
      .map((e) => ({ employee: { id: e.id, name: e.name }, off: byEmployee.get(e.id).off[0] || null }))
      .filter((x) => x.off && x.off.kind !== "weekly");
    res.json({ today, pending, away, holiday: hol.get(today) || null });
  } catch (err) {
    next(err);
  }
});

absences.post("/", async (req, res, next) => {
  try {
    const manager = isManager(req.user);
    const b = req.body || {};
    const problem = w.checkAbsence(b);
    if (problem) throw badRequest(problem);
    let employeeId;
    if (manager && b.employeeId != null) employeeId = parseId(b.employeeId, "employeeId");
    else if (req.user.employee) employeeId = req.user.employee.id;
    else throw badRequest("employeeId is required");
    const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true } });
    if (!employee) throw badRequest("unknown employee");
    const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 500) : null;
    const row = await prisma.absence.create({
      data: {
        employeeId,
        from: b.from,
        to: b.to,
        kind: b.kind,
        note,
        requestedById: req.user.id,
        // A manager adding it: approved at once.
        ...(manager ? { status: "approved", decidedById: req.user.id, decidedAt: new Date() } : { status: "pending" }),
      },
      include: ABSENCE_INCLUDE,
    });
    res.status(201).json(shape(row));
  } catch (err) {
    next(err);
  }
});

absences.patch("/:id", async (req, res, next) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    const b = req.body || {};
    if (!["approved", "rejected"].includes(b.status)) throw badRequest("invalid status");
    const row = await prisma.absence.update({
      where: { id: parseId(req.params.id) },
      data: { status: b.status, decidedById: req.user.id, decidedAt: new Date() },
      include: ABSENCE_INCLUDE,
    });
    res.json(shape(row));
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "not_found" });
    next(err);
  }
});

absences.delete("/:id", async (req, res, next) => {
  try {
    const row = await prisma.absence.findUnique({ where: { id: parseId(req.params.id) } });
    const own = row && req.user.employee?.id === row.employeeId && row.status === "pending";
    if (!row || (!isManager(req.user) && !own)) return res.status(404).json({ error: "not_found" });
    await prisma.absence.delete({ where: { id: row.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = { holidays, absences };
