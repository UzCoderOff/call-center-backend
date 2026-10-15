const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isManager, isLawyer } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { firmNow, isValidDate, shiftDate } = require("../lib/firmTime");
const { LAWYER_ROLES, LAWYER_NAME, displayName } = require("../lib/lawyers");
const { lawyerCaseWhere, caseRole, isCaseLawyer, EXTRA_LAWYERS } = require("../lib/clientAccess");
const { events: bus } = require("../lib/events");
const repeats = require("../services/repeats");

// A lawyer's own calendar (2026-10-14) — their day: court, meetings, work,
// personal time. Separate from the consultation calendar (routes/calendar.js),
// which each lawyer can switch off; this one every lawyer account has. Its
// days also show, read-only, the key dates of their cases (hearings,
// deadlines — CaseDate) and the consultations booked with them.
//
//   GET    /api/personal-calendar/people           whose calendars you can see
//   GET    /api/personal-calendar?from=&to=&userId= one person's days (userId
//                                                  "all": everyone's — managers)
//   GET    /api/personal-calendar/free?date=       who's busy when that day — every lawyer
//                                                  (lawyers and managers; others' details only for managers)
//   POST   /api/personal-calendar/events           add { ownerId?, date, start?, end?, kind, title, place?, note?, caseId?,
//                                                  repeat?: "daily"|"workdays"|"weekly", repeatUntil? }
//   PATCH  /api/personal-calendar/events/:id       change it (move it: date/start/end) — a series: all of it
//   DELETE /api/personal-calendar/events/:id       remove it (kept, hidden); a series: ?date= takes
//                                                  out that day only, without it the whole series
//
// Who: a lawyer sees and changes their own; the managers (boss, developer)
// see everyone's and may add to anyone's — the owner is told (Telegram/app).

const KINDS = ["court", "meeting", "work", "personal", "other"];
const MAX_DAYS = 42;

const router = express.Router();
router.use(requireAuth);

function forbidden() {
  return Object.assign(new Error("forbidden"), { status: 403 });
}
function notFound() {
  return Object.assign(new Error("not_found"), { status: 404 });
}

// Whose calendars this person may see: a lawyer their own; managers every
// lawyer account (and their own).
async function visiblePeople(user) {
  if (isLawyer(user)) {
    const me = await prisma.user.findUnique({ where: { id: user.id }, select: { ...LAWYER_NAME, role: true, calendar: { select: { id: true, name: true, active: true } } } });
    return [me];
  }
  if (!isManager(user)) return [];
  const rows = await prisma.user.findMany({
    where: { active: true, OR: [{ role: { in: LAWYER_ROLES } }, { id: user.id }] },
    select: { ...LAWYER_NAME, role: true, calendar: { select: { id: true, name: true, active: true } } },
  });
  return rows.sort((a, b) => (a.id === user.id ? -1 : b.id === user.id ? 1 : displayName(a).localeCompare(displayName(b))));
}

const mayEdit = (user, ownerId) => user.id === ownerId || isManager(user);

function minutes(value, name) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 24 * 60) throw badRequest(`invalid ${name}`);
  return n;
}

function text(value, max) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const s = String(value).trim().slice(0, max);
  return s || null;
}

// The fields of an event from a request, checked; `current` for a change.
function eventFields(b, current = null) {
  const data = {};
  if (b.date !== undefined) {
    if (!isValidDate(b.date)) throw badRequest("invalid date");
    data.date = b.date;
  }
  const start = minutes(b.start, "start");
  const end = minutes(b.end, "end");
  if (start !== undefined) data.start = start;
  if (end !== undefined) data.end = end;
  if (b.kind !== undefined) {
    if (!KINDS.includes(b.kind)) throw badRequest("invalid kind");
    data.kind = b.kind;
  }
  if (b.title !== undefined) {
    const title = text(b.title, 160);
    if (!title) throw badRequest("title is required");
    data.title = title;
  }
  for (const [key, max] of [
    ["place", 200],
    ["note", 2000],
  ]) {
    const v = text(b[key], max);
    if (v !== undefined) data[key] = v;
  }
  // The whole day (no start) has no end either; an end needs a start and
  // comes after it.
  const s = data.start !== undefined ? data.start : current?.start ?? null;
  let e = data.end !== undefined ? data.end : current?.end ?? null;
  if (s == null && e != null) data.end = e = null;
  if (s != null && e != null && e <= s) throw badRequest("end must be after start");
  Object.assign(data, repeats.repeatFields(b, data.date ?? current?.date ?? null));
  return data;
}

// A case to link an event to: one both the editor and the calendar's owner
// work on (its details show on the event).
async function caseFor(user, caseId, ownerId) {
  if (caseId === undefined) return undefined;
  if (caseId === null || caseId === "") return null;
  const id = parseId(caseId, "caseId");
  const kase = await prisma.clientCase.findUnique({
    where: { id },
    select: { id: true, status: true, operatorId: true, coordinatorId: true, lawyerId: true, extraLawyers: EXTRA_LAWYERS, client: { select: { createdById: true, cases: { select: { operatorId: true } } } } },
  });
  const role = kase ? caseRole(user, kase, kase.client) : null;
  if (!role || role === "result") throw badRequest("unknown case");
  if (ownerId !== user.id) {
    const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { role: true } });
    if (!owner || (owner.role === "LAWYER" && !isCaseLawyer(kase, ownerId))) throw badRequest("unknown case");
  }
  return id;
}

const CASE_SELECT = { id: true, matter: true, number: true, client: { select: { id: true, name: true } } };
const caseOut = (k) => (k ? { id: k.id, matter: k.matter, number: k.number, clientId: k.client.id, clientName: k.client.name } : null);

// `on`: the day shown (a repeating event's occurrence; its first day otherwise).
function eventOut(e, user, on = e.date) {
  return {
    type: "event",
    id: e.id,
    ownerId: e.ownerId,
    date: on,
    seriesDate: e.date,
    repeat: e.repeat ?? null,
    repeatUntil: e.repeatUntil ?? null,
    start: e.start,
    end: e.end,
    kind: e.kind,
    title: e.title,
    place: e.place,
    note: e.note,
    case: caseOut(e.case),
    // Added by someone else (the boss): who.
    addedBy: e.createdById && e.createdById !== e.ownerId && e.createdBy ? displayName(e.createdBy) : null,
    canEdit: mayEdit(user, e.ownerId),
  };
}

router.get("/people", async (req, res, next) => {
  try {
    const people = await visiblePeople(req.user);
    if (people.length === 0) throw forbidden();
    res.json(
      people.map((p) => ({
        id: p.id,
        name: displayName(p),
        role: p.role,
        isMe: p.id === req.user.id,
        // Their consultation calendar (routes/calendar.js), if they have one.
        consult: p.calendar ? { id: p.calendar.id, active: p.calendar.active } : null,
        canEdit: mayEdit(req.user, p.id),
      }))
    );
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const now = firmNow();
    const from = req.query.from ?? now.date;
    const to = req.query.to ?? shiftDate(from, 6);
    if (!isValidDate(from) || !isValidDate(to) || to < from) throw badRequest("invalid range");
    if (shiftDate(from, MAX_DAYS) < to) throw badRequest("range too long");

    const people = await visiblePeople(req.user);
    if (people.length === 0) throw forbidden();
    const wanted = req.query.userId === "all" ? (isManager(req.user) ? people : null) : people.filter((p) => p.id === (req.query.userId ? Number(req.query.userId) : req.user.id));
    if (!wanted || wanted.length === 0) throw notFound();
    const ids = wanted.map((p) => p.id);
    const range = { gte: from, lte: to };

    const [own, caseDates, consultations] = await Promise.all([
      prisma.personalEvent.findMany({
        where: { ownerId: { in: ids }, deletedAt: null, ...repeats.rangeWhere(from, to) },
        orderBy: [{ date: "asc" }, { start: "asc" }, { id: "asc" }],
        include: { case: { select: CASE_SELECT }, createdBy: { select: LAWYER_NAME } },
      }),
      // Their cases' key dates (main lawyer or one of the others on it).
      prisma.caseDate.findMany({
        where: { deletedAt: null, date: range, case: { OR: ids.map((id) => lawyerCaseWhere(id)), client: { archivedAt: null } } },
        orderBy: [{ date: "asc" }, { time: "asc" }],
        select: { id: true, kind: true, date: true, time: true, title: true, place: true, outcome: true, case: { select: { ...CASE_SELECT, lawyerId: true, extraLawyers: { select: { userId: true } } } } },
      }),
      // The consultations booked with them.
      prisma.appointment.findMany({
        where: { date: range, status: { in: ["booked", "attended", "no_show"] }, calendar: { ownerId: { in: ids } } },
        orderBy: [{ date: "asc" }, { start: "asc" }],
        select: { id: true, date: true, start: true, end: true, status: true, format: true, clientName: true, matter: true, clientId: true, calendar: { select: { id: true, ownerId: true } } },
      }),
    ]);

    const items = [
      ...own.flatMap((e) => repeats.occurrences(e, from, to).map((day) => eventOut(e, req.user, day))),
      ...caseDates.flatMap((d) =>
        ids
          .filter((id) => d.case.lawyerId === id || d.case.extraLawyers.some((x) => x.userId === id))
          .map((ownerId) => ({
            type: "caseDate",
            id: d.id,
            ownerId,
            date: d.date,
            start: d.time,
            end: null,
            kind: d.kind,
            title: d.title,
            place: d.place,
            outcome: d.outcome,
            case: caseOut(d.case),
          }))
      ),
      ...consultations.map((a) => ({
        type: "consultation",
        id: a.id,
        ownerId: a.calendar.ownerId,
        calendarId: a.calendar.id,
        date: a.date,
        start: a.start,
        end: a.end,
        status: a.status,
        format: a.format,
        title: a.clientName,
        matter: a.matter,
        clientId: a.clientId,
      })),
    ].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : (x.start ?? -1) - (y.start ?? -1)));

    res.json({
      from,
      to,
      today: now.date,
      nowMinutes: now.minutes,
      people: wanted.map((p) => ({ id: p.id, name: displayName(p), canEdit: mayEdit(req.user, p.id), consult: p.calendar ? { id: p.calendar.id, active: p.calendar.active } : null })),
      items,
    });
  } catch (err) {
    next(err);
  }
});

// Who's free that day (Kalendar → "Kim boʻsh?"): every lawyer account's busy
// times — their own events, their cases' dates (a timed one counts as an
// hour), the consultations booked with them — to find a time for two of
// them. A lawyer sees what each of the others has (court, meeting…) but not
// the details; managers see everything, as on the calendar.
const CASE_DATE_MINUTES = 60;
router.get("/free", async (req, res, next) => {
  try {
    if (!isLawyer(req.user) && !isManager(req.user)) throw forbidden();
    const now = firmNow();
    const date = req.query.date ?? now.date;
    if (!isValidDate(date)) throw badRequest("invalid date");
    const lawyers = await prisma.user.findMany({
      where: { active: true, role: { in: LAWYER_ROLES } },
      select: { ...LAWYER_NAME, role: true },
    });
    const ids = lawyers.map((u) => u.id);
    const [own, caseDates, consultations] = await Promise.all([
      prisma.personalEvent.findMany({ where: { ownerId: { in: ids }, deletedAt: null, ...repeats.rangeWhere(date, date) }, include: { case: { select: CASE_SELECT } } }),
      prisma.caseDate.findMany({
        where: { deletedAt: null, date, case: { OR: ids.map((id) => lawyerCaseWhere(id)), client: { archivedAt: null } } },
        select: { id: true, kind: true, time: true, title: true, place: true, case: { select: { ...CASE_SELECT, lawyerId: true, extraLawyers: { select: { userId: true } } } } },
      }),
      prisma.appointment.findMany({
        where: { date, status: { in: ["booked", "attended", "no_show"] }, calendar: { ownerId: { in: ids } } },
        select: { id: true, start: true, end: true, clientName: true, calendar: { select: { ownerId: true } } },
      }),
    ]);
    const full = (ownerId) => isManager(req.user) || ownerId === req.user.id;
    const blocks = new Map(ids.map((id) => [id, []]));
    for (const e of own) {
      if (!repeats.occurrences(e, date, date).length) continue;
      blocks.get(e.ownerId).push({ type: "event", kind: e.kind, start: e.start, end: e.start == null ? null : e.end ?? e.start + 60, title: full(e.ownerId) ? e.title : null });
    }
    for (const d of caseDates) {
      for (const id of ids.filter((id) => d.case.lawyerId === id || d.case.extraLawyers.some((x) => x.userId === id))) {
        blocks.get(id).push({ type: "caseDate", kind: d.kind, start: d.time, end: d.time == null ? null : d.time + CASE_DATE_MINUTES, title: full(id) ? d.title || d.case.client.name : null });
      }
    }
    for (const a of consultations) {
      blocks.get(a.calendar.ownerId).push({ type: "consultation", kind: "consultation", start: a.start, end: a.end, title: full(a.calendar.ownerId) ? a.clientName : null });
    }
    res.json({
      date,
      today: now.date,
      people: lawyers
        .map((u) => ({
          id: u.id,
          name: displayName(u),
          isMe: u.id === req.user.id,
          busy: blocks.get(u.id).sort((x, y) => (x.start ?? -1) - (y.start ?? -1)),
        }))
        .sort((a, b) => (a.isMe ? -1 : b.isMe ? 1 : a.name.localeCompare(b.name))),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/events", async (req, res, next) => {
  try {
    const b = req.body || {};
    const ownerId = b.ownerId === undefined || b.ownerId === null ? req.user.id : parseId(b.ownerId, "ownerId");
    const people = await visiblePeople(req.user);
    if (!people.some((p) => p.id === ownerId) || !mayEdit(req.user, ownerId)) throw forbidden();
    const data = eventFields({ kind: "meeting", ...b });
    if (!data.date) throw badRequest("invalid date");
    if (!data.title) throw badRequest("title is required");
    const caseId = await caseFor(req.user, b.caseId, ownerId);
    const created = await prisma.personalEvent.create({
      data: { ...data, ownerId, caseId: caseId ?? null, createdById: req.user.id },
      include: { case: { select: CASE_SELECT }, createdBy: { select: LAWYER_NAME } },
    });
    if (ownerId !== req.user.id) bus.emit("personal.added", { eventId: created.id, byUserId: req.user.id });
    res.status(201).json(eventOut(created, req.user));
  } catch (err) {
    next(err);
  }
});

async function loadEvent(req) {
  const event = await prisma.personalEvent.findUnique({ where: { id: parseId(req.params.id) } });
  if (!event || event.deletedAt) throw notFound();
  if (event.ownerId !== req.user.id && !isManager(req.user)) throw notFound();
  if (!mayEdit(req.user, event.ownerId)) throw forbidden();
  return event;
}

router.patch("/events/:id", async (req, res, next) => {
  try {
    const event = await loadEvent(req);
    const b = req.body || {};
    const data = eventFields(b, event);
    const caseId = await caseFor(req.user, b.caseId, event.ownerId);
    if (caseId !== undefined) data.caseId = caseId;
    const updated = await prisma.personalEvent.update({
      where: { id: event.id },
      data,
      include: { case: { select: CASE_SELECT }, createdBy: { select: LAWYER_NAME } },
    });
    // Moved by someone else (not just retitled): the owner is told.
    const moved = ["date", "start", "end"].some((k) => data[k] !== undefined && data[k] !== event[k]);
    if (event.ownerId !== req.user.id && moved) bus.emit("personal.moved", { eventId: event.id, byUserId: req.user.id });
    res.json(eventOut(updated, req.user));
  } catch (err) {
    next(err);
  }
});

router.delete("/events/:id", async (req, res, next) => {
  try {
    const event = await loadEvent(req);
    // One day of a series: taken out of it.
    if (event.repeat && req.query.date) {
      const day = String(req.query.date);
      if (!isValidDate(day) || !repeats.occurrences(event, day, day).length) throw badRequest("not a day of this series");
      const skip = [...new Set([...(Array.isArray(event.skipDates) ? event.skipDates : []), day])].sort();
      await prisma.personalEvent.update({ where: { id: event.id }, data: { skipDates: skip } });
      return res.json({ ok: true, skipped: day });
    }
    await prisma.personalEvent.update({ where: { id: event.id }, data: { deletedAt: new Date() } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.KINDS = KINDS;
module.exports.eventFields = eventFields;
