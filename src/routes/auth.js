const express = require("express");
const prisma = require("../lib/prisma");
const { verifyPassword, hashPassword } = require("../lib/passwords");
const { signSessionToken } = require("../lib/tokens");
const { requireAuth } = require("../middleware/auth");
const env = require("../config/env");

// Deliberately generous — this guards against trivially weak passwords
// without being a source of confusing rejected-for-no-clear-reason support
// tickets. Tighten later if there's an actual policy to enforce.
const MIN_PASSWORD_LENGTH = 8;

const router = express.Router();

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.cookieSecure,
  sameSite: env.cookieSameSite,
  maxAge: 12 * 60 * 60 * 1000, // 12h; independent of JWT_EXPIRES_IN, just a cookie lifetime ceiling
};

router.post("/login", async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }

    const user = await prisma.user.findUnique({
      where: { username },
      include: { employee: true },
    });

    // Same generic error whether the username doesn't exist or the password
    // is wrong — don't help an attacker enumerate valid usernames.
    if (!user || !user.active || !(await verifyPassword(password, user.passwordHash))) {
      return res.status(401).json({ error: "invalid_credentials" });
    }

    const token = signSessionToken(user);
    res.cookie("session", token, COOKIE_OPTIONS);
    res.json({
      id: user.id,
      username: user.username,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      employee: user.employee
        ? { id: user.employee.id, name: user.employee.name }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/logout", (req, res) => {
  res.clearCookie("session", COOKIE_OPTIONS);
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    username: req.user.username,
    role: req.user.role,
    mustChangePassword: req.user.mustChangePassword,
    employee: req.user.employee
      ? { id: req.user.employee.id, name: req.user.employee.name }
      : null,
  });
});

// Every role — DEVELOPER, BOSS, EMPLOYEE — can change their own password
// from their profile. Requires the current password (whether that's still
// the original temp one or something they already changed it to) so a
// session left open on a shared/unlocked device can't be used to lock the
// real owner out.
router.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "currentPassword and newPassword are required" });
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: "password_too_short", minLength: MIN_PASSWORD_LENGTH });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      return res.status(401).json({ error: "invalid_current_password" });
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
