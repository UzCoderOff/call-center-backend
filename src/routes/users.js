const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, requireRole } = require("../middleware/auth");
const { hashPassword } = require("../lib/passwords");
const { generateTempPassword } = require("../lib/tempPassword");

const router = express.Router();
router.use(requireAuth);

// Standalone accounts (see schema.prisma: "DEVELOPER and BOSS accounts
// stand alone") — a User with no linked Employee row. There is no
// employeeId/device token and no phone number, because a BOSS never syncs
// call data from a device; they just need a portal login.
//
// DEVELOPER accounts are deliberately NOT createable here — the only way
// one comes into existence is prisma/seed.js, run directly against the
// database. That "no open registration for the top role" rule predates
// this file (see the comment in seed.js) and this endpoint preserves it:
// it only ever creates/manages BOSS and LAWYER accounts, and refuses to
// touch a DEVELOPER row even if someone guesses its id.
//
// BOSS sees everything. LAWYER — the firm's other lawyers — sees only their
// own calendar and the cases assigned to them. Switching an account between
// the two ("sees everything" on/off) takes effect on its next request.
const MANAGEABLE_ROLES = ["BOSS", "LAWYER"];

const WITH_CALENDAR = { calendar: { select: { id: true, name: true, active: true } } };

// A boss or lawyer account can keep an appointment calendar. Turning it on
// creates the calendar (named after the account unless a name is given);
// turning it off hides it, keeping its history.
async function setCalendar(userId, enabled, name) {
  const existing = await prisma.calendar.findUnique({ where: { ownerId: userId } });
  const cleanName = typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : undefined;
  if (existing) {
    await prisma.calendar.update({
      where: { id: existing.id },
      data: { active: enabled, ...(cleanName ? { name: cleanName } : {}) },
    });
  } else if (enabled) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    await prisma.calendar.create({ data: { ownerId: userId, name: cleanName || user.name || user.username } });
  }
}

function cleanName(value) {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : null;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    name: user.name ?? null,
    role: user.role,
    active: user.active,
    calendar: user.calendar && user.calendar.active ? { id: user.calendar.id, name: user.calendar.name } : null,
    createdAt: user.createdAt,
    passwordStatus: {
      mustChangePassword: user.mustChangePassword,
      passwordChangedAt: user.passwordChangedAt,
    },
  };
}

router.get("/", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    if (req.query.role && !MANAGEABLE_ROLES.includes(req.query.role)) {
      return res.status(400).json({ error: "unsupported_role_filter" });
    }
    const users = await prisma.user.findMany({
      where: { role: req.query.role ? req.query.role : { in: MANAGEABLE_ROLES } },
      // The one(s) who see everything first, then the lawyers.
      orderBy: [{ role: "asc" }, { username: "asc" }],
      include: WITH_CALENDAR,
    });
    res.json(users.map(publicUser));
  } catch (err) {
    next(err);
  }
});

router.post("/", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const { username } = req.body || {};
    if (!username || !username.trim()) {
      return res.status(400).json({ error: "username is required" });
    }
    const cleanUsername = username.trim();

    const existing = await prisma.user.findUnique({ where: { username: cleanUsername } });
    if (existing) {
      return res.status(409).json({ error: "username_taken" });
    }

    const role = req.body?.role ?? "BOSS";
    if (!MANAGEABLE_ROLES.includes(role)) return res.status(400).json({ error: "invalid_role" });

    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    const created = await prisma.user.create({
      data: { username: cleanUsername, name: cleanName(req.body?.name) ?? null, passwordHash, role, mustChangePassword: true },
    });
    // A calendar for appointments — on unless turned off.
    if (req.body?.hasCalendar !== false) await setCalendar(created.id, true, req.body?.calendarName);
    const user = await prisma.user.findUnique({ where: { id: created.id }, include: WITH_CALENDAR });

    res.status(201).json({
      user: publicUser(user),
      // Shown exactly once, same as a new employee's credentials.
      credentials: { username: user.username, temporaryPassword: tempPassword },
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing || !MANAGEABLE_ROLES.includes(existing.role)) {
      return res.status(404).json({ error: "not_found" });
    }

    const { active, hasCalendar, calendarName, role } = req.body || {};
    if (role !== undefined && !MANAGEABLE_ROLES.includes(role)) return res.status(400).json({ error: "invalid_role" });
    const name = cleanName(req.body?.name);
    if (typeof hasCalendar === "boolean") await setCalendar(id, hasCalendar, calendarName);
    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(typeof active === "boolean" ? { active } : {}),
        ...(role !== undefined ? { role } : {}),
        ...(name !== undefined ? { name } : {}),
      },
      include: WITH_CALENDAR,
    });
    // Their name on their cases follows the account's.
    if (name !== undefined || hasCalendar !== undefined) {
      await prisma.clientCase.updateMany({ where: { lawyerId: id }, data: { lawyer: user.name || user.calendar?.name || user.username } });
    }
    res.json(publicUser(user));
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "not_found" });
    next(err);
  }
});

router.post("/:id/reset-password", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing || !MANAGEABLE_ROLES.includes(existing.role)) {
      return res.status(404).json({ error: "not_found" });
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    const user = await prisma.user.update({
      where: { id },
      data: { passwordHash, mustChangePassword: true, passwordChangedAt: null },
      include: WITH_CALENDAR,
    });

    res.json({
      user: publicUser(user),
      credentials: { username: user.username, temporaryPassword: tempPassword },
    });
  } catch (err) {
    next(err);
  }
});

// Full removal of a BOSS or LAWYER account. Unlike an employee, they have no
// call history to worry about, so there's no "has history" guard needed —
// just a straight delete (their cases keep the lawyer's name).
router.delete("/:id", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing || !MANAGEABLE_ROLES.includes(existing.role)) {
      return res.status(404).json({ error: "not_found" });
    }
    await prisma.user.delete({ where: { id } });
    res.status(204).end();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "not_found" });
    next(err);
  }
});

module.exports = router;
