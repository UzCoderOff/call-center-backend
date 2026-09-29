const express = require("express");
const prisma = require("../lib/prisma");
const { verifyPassword, hashPassword } = require("../lib/passwords");
const { startSession, endSession, publicMe } = require("../lib/session");
const throttle = require("../lib/loginThrottle");
const { requireAuth } = require("../middleware/auth");

// Deliberately generous — this guards against trivially weak passwords
// without being a source of confusing rejected-for-no-clear-reason support
// tickets. Tighten later if there's an actual policy to enforce.
const MIN_PASSWORD_LENGTH = 8;

const router = express.Router();

// Shared with the Android app's sign-in (routes/device.js). Same generic
// error whether the username doesn't exist or the password is wrong — don't
// help an attacker enumerate valid usernames.
// A hash to compare against when the username doesn't exist, so a wrong
// username takes as long as a wrong password (no telling which it was).
const DUMMY_HASH = hashPassword("not-a-real-password-" + Math.random());

async function checkCredentials(req, res, username, password) {
  if (username.length > throttle.MAX_USERNAME || password.length > 200) return { error: "invalid_credentials", status: 401 };
  if (throttle.isBlocked(req, username)) return { error: "too_many_attempts", status: 429 };

  const user = await prisma.user.findUnique({
    where: { username },
    include: { employee: true },
  });
  const ok = await verifyPassword(password, user?.passwordHash ?? (await DUMMY_HASH));
  if (!user || !user.active || !ok) {
    throttle.recordFailure(req, username);
    return { error: "invalid_credentials", status: 401 };
  }
  throttle.recordSuccess(req, res, username);
  return { user };
}

router.post("/login", async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }

    const result = await checkCredentials(req, res, String(username), String(password));
    if (result.error) return res.status(result.status).json({ error: result.error });

    startSession(res, result.user);
    res.json(publicMe(result.user));
  } catch (err) {
    next(err);
  }
});

router.post("/logout", (req, res) => {
  endSession(res);
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  res.json(publicMe(req.user));
});

// Every role — DEVELOPER, BOSS, EMPLOYEE — can change their own password
// from their profile. Requires the current password (whether that's still
// the original temp one or something they already changed it to) so a
// session left open on a shared/unlocked device can't be used to lock the
// real owner out.
router.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== "string" || typeof newPassword !== "string" || !currentPassword || !newPassword) {
      return res.status(400).json({ error: "currentPassword and newPassword are required" });
    }
    if (newPassword.length > 200) return res.status(400).json({ error: "password_too_long" });
    // Guessing the current password from an open session counts like
    // guessing it at the login screen.
    if (throttle.isBlocked(req, req.user.username)) return res.status(429).json({ error: "too_many_attempts" });
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: "password_too_short", minLength: MIN_PASSWORD_LENGTH });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throttle.recordFailure(req, req.user.username);
      return res.status(401).json({ error: "invalid_current_password" });
    }

    const passwordHash = await hashPassword(newPassword);
    const now = new Date();
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false, passwordChangedAt: now, sessionsValidAfter: now },
    });

    // Logins elsewhere with the old password end; this one goes on with a
    // fresh session. (Phones signed in to the app keep working — signing a
    // phone out is done from Team.)
    startSession(res, updated);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.checkCredentials = checkCredentials;
