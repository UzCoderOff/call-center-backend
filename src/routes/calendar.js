const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, requireRole, isManager, isLawyer } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { phoneKey } = require("../lib/phone");
const { firmNow, isValidDate, isoWeekday, shiftDate, weekStartOf } = require("../lib/firmTime");
const cal = require("../services/calendar");
const { clientForBooking } = require("../lib/clientsDb");
const { events } = require("../lib/events");
const fee = require("../services/consultationFee");

// The lawyer's calendar.
//
//   /api/calendars                          which calendars you can see
//   PATCH /api/calendars/:id                name, the usual week (owner)
//   /api/calendars/:id/weeks/:weekStart     one week: plan, appointments, free slots
//   PUT  …/weeks/:weekStart                 save the plan (owner)
//   POST …/weeks/:weekStart/publish         show it to staff (owner)
//   POST /api/calendars/:id/appointments    book (staff with "book" access, managers)
//   /api/appointments                       by caller / mine / needing attention; update one
//
// Who can do what: the calendar's owner (and DEVELOPER) plans and publishes;
// BOSS/DEVELOPER can see and book everything; employees per their
// calendarAccess ("view" or "book"); a LAWYER sees, runs and books into
// their own calendar only. Staff only ever see published weeks.

function accessOf(user) {
  if (isManager(user)) return "book";
  if (isLawyer(user)) return "none";
  return user.employee?.calendarAccess || "none";
}
const canView = (user) => accessOf(user) !== "none";
const canBook = (user) => accessOf(user) === "book";
const canManage = (user, calendar) => user.role === "DEVELOPER" || calendar.ownerId === user.id;

const APPOINTMENT_INCLUDE = {
  bookedBy: { select: { id: true, username: true, employee: { select: { name: true } } } },
  calendar: { select: { id: true, name: true } },
  // The consultation fee paid for it, if any (visible to everyone who sees
  // the appointment — src/lib/finance.js).
  payments: { where: { kind: "consultation" }, select: { id: true, amount: true, method: true, date: true } },
};

function parseWeekStart(value) {
  if (!isValidDate(value)) throw badRequest("invalid week");
  if (isoWeekday(value) !== 1) throw badRequest("week must start on a Monday");
  return value;
}

async function loadCalendar(req, id, { manage = false } = {}) {
  const calendar = await prisma.calendar.findUnique({ where: { id: parseId(id, "calendarId") } });
  if (!calendar || (!calendar.active && req.user.role !== "DEVELOPER")) {
    const err = new Error("not_found");
    err.status = 404;
    throw err;
  }
  if (manage ? !canManage(req.user, calendar) : !canView(req.user) && calendar.ownerId !== req.user.id) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }
  return calendar;
}

const hasStarted = (a, now) => a.date < now.date || (a.date === now.date && a.start <= now.minutes);

// The first free time from now on, looking through the next published
// weeks — so someone booking a client isn't left on a full or closed day.
const NEXT_FREE_WEEKS = 8;
async function nextFreeSlot(calendar, now) {
  const weeks = await prisma.calendarWeek.findMany({
    where: { calendarId: calendar.id, status: "published", weekStart: { gte: weekStartOf(now.date) } },
    orderBy: { weekStart: "asc" },
    take: NEXT_FREE_WEEKS,
  });
  if (weeks.length === 0) return null;
  const appointments = await prisma.appointment.findMany({
    where: { calendarId: calendar.id, date: { gte: now.date }, status: { not: "cancelled" } },
    select: { date: true, start: true, end: true, status: true },
  });
  for (const week of weeks) {
    const [first] = cal.freeSlots({ blocks: week.blocks, appointments, slotMinutes: calendar.slotMinutes, now });
    if (first) return first;
  }
  return null;
}

// This week's and next week's plan status — drives the owner's "plan next
// week" reminder (shown from Thursday until next week is published).
async function planningStatus(calendarId) {
  const now = firmNow();
  const thisWeek = weekStartOf(now.date);
  const nextWeek = shiftDate(thisWeek, 7);
  const weeks = await prisma.calendarWeek.findMany({
    where: { calendarId, weekStart: { in: [thisWeek, nextWeek] } },
    select: { weekStart: true, status: true },
  });
  const statusOf = (w) => weeks.find((x) => x.weekStart === w)?.status || "none";
  const next = statusOf(nextWeek);
  return {
    thisWeek: { weekStart: thisWeek, status: statusOf(thisWeek) },
    nextWeek: { weekStart: nextWeek, status: next },
    remind: next !== "published" && isoWeekday(now.date) >= 4,
  };
}

// ------------------------------------------------------------- calendars
const calendars = express.Router();
calendars.use(requireAuth);

calendars.get("/", async (req, res, next) => {
  try {
    if (!canView(req.user) && !isLawyer(req.user)) return res.json([]);
    const rows = await prisma.calendar.findMany({
      where: req.user.role === "DEVELOPER" ? {} : { active: true, ...(isLawyer(req.user) ? { ownerId: req.user.id } : {}) },
      include: { owner: { select: { id: true, username: true } } },
      orderBy: { name: "asc" },
    });
    const out = [];
    for (const c of rows) {
      const manage = canManage(req.user, c);
      out.push({
        id: c.id,
        name: c.name,
        slotMinutes: c.slotMinutes,
        active: c.active,
        owner: c.owner,
        isMine: c.ownerId === req.user.id,
        canManage: manage,
        ...(manage ? { usual: cal.usualWeekOf(c), planning: await planningStatus(c.id) } : {}),
      });
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// A calendar belongs to one BOSS/DEVELOPER account (the lawyer). Usually
// created from Team -> Boss accounts; this is the raw endpoint.
calendars.post("/", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const ownerId = parseId(req.body?.ownerId, "ownerId");
    const owner = await prisma.user.findUnique({ where: { id: ownerId } });
    if (!owner || !["BOSS", "DEVELOPER", "LAWYER"].includes(owner.role)) throw badRequest("owner must be a boss or lawyer account");
    const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : owner.username;
    const calendar = await prisma.calendar.upsert({
      where: { ownerId },
      update: { active: true },
      create: { ownerId, name },
    });
    res.status(201).json(calendar);
  } catch (err) {
    next(err);
  }
});

// Name, and the usual week every new week starts from: workDays [1-7],
// dayStart/dayEnd (minutes), lunch { start, end } or null, slotMinutes.
calendars.patch("/:id", async (req, res, next) => {
  try {
    const calendar = await loadCalendar(req, req.params.id, { manage: true });
    const body = req.body || {};
    const data = cal.normalizeUsualWeek(body, calendar);
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) throw badRequest("name is required");
      data.name = body.name.trim().slice(0, 80);
    }
    if (body.active !== undefined && req.user.role === "DEVELOPER") data.active = Boolean(body.active);
    const updated = await prisma.calendar.update({ where: { id: calendar.id }, data });
    res.json({ id: updated.id, name: updated.name, active: updated.active, slotMinutes: updated.slotMinutes, usual: cal.usualWeekOf(updated) });
  } catch (err) {
    next(err);
  }
});

calendars.get("/:id/weeks/:weekStart", async (req, res, next) => {
  try {
    const calendar = await loadCalendar(req, req.params.id);
    const weekStart = parseWeekStart(req.params.weekStart);
    const manage = canManage(req.user, calendar);
    const weekEnd = shiftDate(weekStart, 6);

    const [week, appointments] = await Promise.all([
      prisma.calendarWeek.findUnique({ where: { calendarId_weekStart: { calendarId: calendar.id, weekStart } } }),
      prisma.appointment.findMany({
        where: { calendarId: calendar.id, date: { gte: weekStart, lte: weekEnd } },
        include: APPOINTMENT_INCLUDE,
        orderBy: [{ date: "asc" }, { start: "asc" }],
      }),
    ]);

    const usual = cal.usualWeekOf(calendar);
    // Not planned yet: the owner sees it filled in from the usual week
    // (saved or published as is, or changed first); staff see nothing.
    const blocks = week ? week.blocks : manage ? cal.usualWeekBlocks(usual, weekStart) : [];
    const visible = manage || week?.status === "published";
    const now = firmNow();

    res.json({
      calendar: { id: calendar.id, name: calendar.name, slotMinutes: calendar.slotMinutes },
      weekStart,
      today: now.date,
      nowMinutes: now.minutes,
      status: week?.status || "none",
      publishedAt: week?.publishedAt || null,
      blocks: visible ? blocks : [],
      appointments: visible ? (manage ? appointments : appointments.filter(cal.isActive)) : [],
      free: visible ? cal.freeSlots({ blocks, appointments, slotMinutes: calendar.slotMinutes, now }) : [],
      canManage: manage,
      canBook: (canBook(req.user) || manage) && Boolean(week) && visible,
      nextFree: canBook(req.user) || manage ? await nextFreeSlot(calendar, now) : null,
      ...(manage ? { usual } : {}),
    });
  } catch (err) {
    next(err);
  }
});

// Save a week's plan (draft or already published). If the change leaves an
// upcoming booking outside reception time, the answer is 409 with those
// appointments; sending again with cancelAppointments: true (and an optional
// cancelReason, e.g. "Samarqand sudi") cancels them — whoever booked each
// one is then asked, on their home page, to let the client know.
calendars.put("/:id/weeks/:weekStart", async (req, res, next) => {
  try {
    const calendar = await loadCalendar(req, req.params.id, { manage: true });
    const weekStart = parseWeekStart(req.params.weekStart);
    const blocks = cal.normalizeBlocks(req.body?.blocks, weekStart);
    const cancel = req.body?.cancelAppointments === true;
    const reason = typeof req.body?.cancelReason === "string" && req.body.cancelReason.trim() ? req.body.cancelReason.trim().slice(0, 300) : null;
    const now = firmNow();

    const result = await prisma.$transaction(async (tx) => {
      const booked = await tx.appointment.findMany({
        where: { calendarId: calendar.id, date: { gte: weekStart, lte: shiftDate(weekStart, 6) }, status: "booked" },
        include: APPOINTMENT_INCLUDE,
        orderBy: [{ date: "asc" }, { start: "asc" }],
      });
      // Appointments that already happened stay as they are.
      const conflicts = cal.conflictingAppointments(blocks, booked.filter((a) => !hasStarted(a, now)));
      if (conflicts.length > 0 && !cancel) return { conflicts };
      if (conflicts.length > 0) {
        await tx.appointment.updateMany({
          where: { id: { in: conflicts.map((a) => a.id) } },
          data: { status: "cancelled", cancelReason: reason, cancelledById: req.user.id, cancelledAt: new Date(), clientInformed: false },
        });
      }
      const week = await tx.calendarWeek.upsert({
        where: { calendarId_weekStart: { calendarId: calendar.id, weekStart } },
        update: { blocks },
        create: { calendarId: calendar.id, weekStart, blocks },
      });
      return { week, cancelled: conflicts.length, cancelledIds: conflicts.map((a) => a.id) };
    });

    if (result.conflicts) return res.status(409).json({ error: "appointments_conflict", appointments: result.conflicts });
    if (result.cancelledIds.length > 0) events.emit("appointments.cancelled", { appointmentIds: result.cancelledIds, byUserId: req.user.id });
    res.json({ ...result.week, cancelled: result.cancelled });
  } catch (err) {
    next(err);
  }
});

// Show a week to staff. A week that was never changed is published as the
// usual week.
calendars.post("/:id/weeks/:weekStart/publish", async (req, res, next) => {
  try {
    const calendar = await loadCalendar(req, req.params.id, { manage: true });
    const weekStart = parseWeekStart(req.params.weekStart);
    const published = { status: "published", publishedAt: new Date() };
    const week = await prisma.calendarWeek.upsert({
      where: { calendarId_weekStart: { calendarId: calendar.id, weekStart } },
      update: published,
      create: { calendarId: calendar.id, weekStart, blocks: cal.usualWeekBlocks(cal.usualWeekOf(calendar), weekStart), ...published },
    });
    res.json(week);
  } catch (err) {
    next(err);
  }
});

// Book a client appointment into published free time. Immediate — no
// approval step: the lawyer already approved this time by publishing it.
calendars.post("/:id/appointments", async (req, res, next) => {
  try {
    const calendar = await loadCalendar(req, req.params.id);
    const manage = canManage(req.user, calendar);
    // Staff with "book" access and managers; the owner into their own.
    if (!canBook(req.user) && !manage) return res.status(403).json({ error: "forbidden" });

    const b = req.body || {};
    if (!isValidDate(b.date)) throw badRequest("invalid date");
    const start = Number(b.start);
    const duration = b.duration === undefined ? calendar.slotMinutes : Number(b.duration);
    if (!Number.isInteger(start) || start < 0 || start >= 24 * 60) throw badRequest("invalid start");
    if (!Number.isInteger(duration) || duration < 10 || duration > 240) throw badRequest("invalid duration");
    const end = start + duration;
    const clientName = typeof b.clientName === "string" ? b.clientName.trim().slice(0, 120) : "";
    if (!clientName) throw badRequest("clientName is required");
    const clientPhone = typeof b.clientPhone === "string" && b.clientPhone.trim() ? b.clientPhone.trim().slice(0, 40) : null;
    // "Fee received": the consultation fee, recorded with the booking. It
    // goes on the client's record, so it needs a phone number to find or
    // create the client by. Lawyers don't record payments.
    let feeTaken = null;
    if (b.feeReceived === true) {
      if (isLawyer(req.user)) return res.status(403).json({ error: "forbidden" });
      if (!phoneKey(clientPhone)) return res.status(400).json({ error: "phone_required_for_fee" });
      feeTaken = fee.normalizeFee(b);
    }

    let callLogId = null;
    if (b.callLogId != null) {
      const call = await prisma.callLog.findUnique({ where: { id: parseId(b.callLogId, "callLogId") } });
      const own = isManager(req.user) || call?.employeeId === req.user.employee?.id;
      if (call && own) callLogId = call.id;
    }

    if (hasStarted({ date: b.date, start }, firmNow())) return res.status(409).json({ error: "in_the_past" });

    // Check and insert in one transaction, so two people can't book the
    // same slot at the same moment.
    const result = await prisma.$transaction(async (tx) => {
      const week = await tx.calendarWeek.findUnique({
        where: { calendarId_weekStart: { calendarId: calendar.id, weekStart: weekStartOf(b.date) } },
      });
      if (!week || (!manage && week.status !== "published")) return { error: "not_published" };
      if (!cal.fitsAvailability(week.blocks, b.date, start, end)) return { error: "not_free_time" };
      const sameDay = await tx.appointment.findMany({
        where: { calendarId: calendar.id, date: b.date, status: { not: "cancelled" } },
      });
      if (sameDay.some((a) => cal.overlaps(a, { date: b.date, start, end }))) return { error: "slot_taken" };
      const appointment = await tx.appointment.create({
        data: {
          calendarId: calendar.id,
          date: b.date,
          start,
          end,
          clientName,
          clientPhone,
          phoneKey: phoneKey(clientPhone),
          matter: typeof b.matter === "string" && b.matter.trim() ? b.matter.trim().slice(0, 300) : null,
          notes: typeof b.notes === "string" && b.notes.trim() ? b.notes.trim().slice(0, 2000) : null,
          bookedById: req.user.id,
          callLogId,
        },
        include: APPOINTMENT_INCLUDE,
      });
      // The booking belongs to a client in the clients database — found by
      // phone number, or added (with a consultation case for the booker).
      const clientId = await clientForBooking(tx, {
        name: clientName,
        phone: clientPhone,
        matter: appointment.matter,
        date: b.date,
        user: req.user,
        lawyerId: calendar.ownerId,
      });
      if (clientId) {
        await tx.appointment.update({ where: { id: appointment.id }, data: { clientId } });
        appointment.clientId = clientId;
        if (feeTaken) appointment.payments = [await fee.recordFee(tx, { appointment, clientId, user: req.user, ...feeTaken })];
      }
      // A client booked again has clearly been told about the cancelled
      // appointment — take it off the "tell the client" list.
      if (appointment.phoneKey) {
        await tx.appointment.updateMany({
          where: { calendarId: calendar.id, phoneKey: appointment.phoneKey, status: "cancelled", clientInformed: false },
          data: { clientInformed: true },
        });
      }
      return { appointment };
    });

    if (result.error) return res.status(409).json({ error: result.error });
    events.emit("appointment.booked", { appointmentId: result.appointment.id });
    // A lawyer learns the client record only if it's one of theirs — not
    // whether some phone number belongs to one of the firm's clients.
    if (isLawyer(req.user) && result.appointment.clientId) {
      const theirs = await prisma.clientCase.count({ where: { clientId: result.appointment.clientId, lawyerId: req.user.id } });
      if (!theirs) result.appointment.clientId = null;
    }
    res.status(201).json(result.appointment);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------- appointments
const appointments = express.Router();
appointments.use(requireAuth);

// Upcoming appointments for a caller (?phone=) — shown on a call's page —
// or the ones you booked (?mine=true). ?attention=true: ones you booked that
// someone else cancelled (usually the lawyer changing their day) and whose
// client hasn't been told yet.
appointments.get("/", async (req, res, next) => {
  try {
    if (!canView(req.user) && !isLawyer(req.user)) return res.json([]);
    const today = firmNow().date;
    // A lawyer: only appointments in their own calendar.
    const where = { date: { gte: today }, status: "booked", calendar: { active: true, ...(isLawyer(req.user) ? { ownerId: req.user.id } : {}) } };
    if (req.query.attention === "true") {
      where.status = "cancelled";
      where.bookedById = req.user.id;
      where.clientInformed = false;
      where.AND = [{ cancelledById: { not: null } }, { cancelledById: { not: req.user.id } }];
    } else if (req.query.phone) {
      const key = phoneKey(String(req.query.phone));
      if (!key) return res.json([]);
      where.phoneKey = key;
    } else if (req.query.mine === "true") {
      where.bookedById = req.user.id;
    } else {
      throw badRequest("phone, mine=true or attention=true is required");
    }
    const rows = await prisma.appointment.findMany({
      where,
      include: APPOINTMENT_INCLUDE,
      orderBy: [{ date: "asc" }, { start: "asc" }],
      take: 20,
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Update one appointment. The calendar's owner (and DEVELOPER) can do
// anything: mark attended / no-show, cancel, edit details. Whoever booked it
// (and other managers) can cancel it before it happens, and tick "client
// informed" after someone else cancelled it.
appointments.patch("/:id", async (req, res, next) => {
  try {
    const appointment = await prisma.appointment.findUnique({
      where: { id: parseId(req.params.id) },
      include: { calendar: true },
    });
    if (!appointment || (!canView(req.user) && appointment.calendar.ownerId !== req.user.id)) return res.status(404).json({ error: "not_found" });

    const manage = canManage(req.user, appointment.calendar);
    const isBooker = appointment.bookedById === req.user.id;
    const b = req.body || {};
    const data = {};

    if (b.status !== undefined) {
      if (!["booked", "attended", "no_show", "cancelled"].includes(b.status)) throw badRequest("invalid status");
      const mayCancel =
        b.status === "cancelled" &&
        appointment.status === "booked" &&
        !hasStarted(appointment, firmNow()) &&
        (isBooker || isManager(req.user));
      if (!manage && !mayCancel) return res.status(403).json({ error: "forbidden" });
      data.status = b.status;
      if (b.status === "cancelled") {
        data.cancelReason = typeof b.cancelReason === "string" && b.cancelReason.trim() ? b.cancelReason.trim().slice(0, 300) : null;
        data.cancelledById = req.user.id;
        data.cancelledAt = new Date();
        data.clientInformed = false;
      } else {
        Object.assign(data, { cancelReason: null, cancelledById: null, cancelledAt: null });
      }
    }

    if (b.clientInformed !== undefined) {
      if (!isBooker && !isManager(req.user)) return res.status(403).json({ error: "forbidden" });
      data.clientInformed = Boolean(b.clientInformed);
    }

    // Details: owner, or whoever booked it while it's still booked.
    const mayEdit = manage || (isBooker && appointment.status === "booked");
    for (const field of ["clientName", "clientPhone", "matter", "notes"]) {
      if (b[field] === undefined) continue;
      if (!mayEdit) return res.status(403).json({ error: "forbidden" });
      const value = typeof b[field] === "string" ? b[field].trim() : "";
      if (field === "clientName" && !value) throw badRequest("clientName is required");
      data[field] = value || null;
      if (field === "clientPhone") data.phoneKey = phoneKey(value);
    }

    // Bringing a cancelled appointment back: its time may have been given to
    // someone else meanwhile — check like a new booking, in one transaction.
    const reviving = data.status && data.status !== "cancelled" && appointment.status === "cancelled";
    const updated = await prisma.$transaction(async (tx) => {
      if (reviving) {
        const others = await tx.appointment.findMany({
          where: { calendarId: appointment.calendarId, date: appointment.date, status: { not: "cancelled" }, id: { not: appointment.id } },
        });
        if (others.some((a) => cal.overlaps(a, appointment))) return null;
      }
      return tx.appointment.update({ where: { id: appointment.id }, data, include: APPOINTMENT_INCLUDE });
    });
    if (!updated) return res.status(409).json({ error: "slot_taken" });
    if (data.status === "cancelled" && appointment.status !== "cancelled") {
      events.emit("appointments.cancelled", { appointmentIds: [appointment.id], byUserId: req.user.id });
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// The consultation fee, when it's paid after booking (at the appointment,
// say): { feeAmount?, feeMethod? }. Whoever may book, or a manager; not
// lawyers; once per appointment.
appointments.post("/:id/fee", async (req, res, next) => {
  try {
    if (isLawyer(req.user) || (!canBook(req.user) && !isManager(req.user))) return res.status(403).json({ error: "forbidden" });
    const appointment = await prisma.appointment.findUnique({ where: { id: parseId(req.params.id) }, include: { payments: { where: { kind: "consultation" } } } });
    if (!appointment) return res.status(404).json({ error: "not_found" });
    if (appointment.status === "cancelled") return res.status(409).json({ error: "cancelled" });
    if (appointment.payments.length > 0) return res.status(409).json({ error: "fee_already_recorded" });
    const taken = fee.normalizeFee(req.body || {});
    const updated = await prisma.$transaction(async (tx) => {
      // Booked without a phone number: no client yet — find or add one now.
      let clientId = appointment.clientId;
      if (!clientId) {
        if (!appointment.phoneKey) return null;
        clientId = await clientForBooking(tx, {
          name: appointment.clientName,
          phone: appointment.clientPhone,
          matter: appointment.matter,
          date: appointment.date,
          user: req.user,
          lawyerId: (await tx.calendar.findUnique({ where: { id: appointment.calendarId } })).ownerId,
        });
        await tx.appointment.update({ where: { id: appointment.id }, data: { clientId } });
      }
      await fee.recordFee(tx, { appointment, clientId, user: req.user, ...taken });
      return tx.appointment.findUnique({ where: { id: appointment.id }, include: APPOINTMENT_INCLUDE });
    });
    if (!updated) return res.status(400).json({ error: "phone_required_for_fee" });
    res.status(201).json(updated);
  } catch (err) {
    next(err);
  }
});

module.exports = { calendars, appointments };
