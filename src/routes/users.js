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
// it only ever creates/manages BOSS accounts, and refuses to touch a
// DEVELOPER row even if someone guesses its id.
const MANAGEABLE_ROLE = "BOSS";

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    active: user.active,
    createdAt: user.createdAt,
    passwordStatus: {
      mustChangePassword: user.mustChangePassword,
      passwordChangedAt: user.passwordChangedAt,
    },
  };
}

router.get("/", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const role = req.query.role || MANAGEABLE_ROLE;
    if (role !== MANAGEABLE_ROLE) {
      return res.status(400).json({ error: "unsupported_role_filter" });
    }
    const users = await prisma.user.findMany({
      where: { role: MANAGEABLE_ROLE },
      orderBy: { username: "asc" },
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

    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    const user = await prisma.user.create({
      data: { username: cleanUsername, passwordHash, role: MANAGEABLE_ROLE, mustChangePassword: true },
    });

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
    if (!existing || existing.role !== MANAGEABLE_ROLE) {
      return res.status(404).json({ error: "not_found" });
    }

    const { active } = req.body || {};
    const user = await prisma.user.update({
      where: { id },
      data: { ...(active !== undefined ? { active } : {}) },
    });
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
    if (!existing || existing.role !== MANAGEABLE_ROLE) {
      return res.status(404).json({ error: "not_found" });
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    const user = await prisma.user.update({
      where: { id },
      data: { passwordHash, mustChangePassword: true, passwordChangedAt: null },
    });

    res.json({
      user: publicUser(user),
      credentials: { username: user.username, temporaryPassword: tempPassword },
    });
  } catch (err) {
    next(err);
  }
});

// Full removal of a BOSS account. Unlike an employee, a BOSS has no call
// history to worry about, so there's no "has history" guard needed — just
// a straight delete.
router.delete("/:id", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing || existing.role !== MANAGEABLE_ROLE) {
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
