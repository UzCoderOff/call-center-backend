const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, requireRole, MANAGER_ROLES } = require("../middleware/auth");
const { hashPassword } = require("../lib/passwords");
const { generateUniqueEmployeeId } = require("../utils/employeeId");
const { generateTempPassword } = require("../lib/tempPassword");

const router = express.Router();
router.use(requireAuth);

// Passwords are one-way bcrypt hashes (see lib/passwords.js) — nobody, not
// even a DEVELOPER, can ever recover or display someone's actual password.
// What a DEVELOPER *can* see is whether an account is still on the
// system-issued temporary password or has been changed since, via
// mustChangePassword/passwordChangedAt below. That's intentionally left out
// of the payload for BOSS/EMPLOYEE viewers — it's account-security metadata,
// not something every manager needs to see.
function publicEmployee(employee, viewerRole) {
  const base = {
    id: employee.id,
    employeeId: employee.employeeId,
    name: employee.name,
    phoneNumber: employee.phoneNumber,
    active: employee.active,
    username: employee.user?.username ?? null,
    createdAt: employee.createdAt,
  };
  if (viewerRole === "DEVELOPER" && employee.user) {
    base.passwordStatus = {
      mustChangePassword: employee.user.mustChangePassword,
      passwordChangedAt: employee.user.passwordChangedAt,
    };
  }
  return base;
}

// BOSS and DEVELOPER can both see the team list and each employee's detail
// page — BOSS is read-only from here down. Only DEVELOPER can add/remove an
// employee, flip active/inactive, rotate a device ID, or reset a password.
router.get("/", requireRole(...MANAGER_ROLES), async (req, res, next) => {
  try {
    const employees = await prisma.employee.findMany({
      include: { user: true },
      orderBy: { name: "asc" },
    });
    res.json(employees.map((e) => publicEmployee(e, req.user.role)));
  } catch (err) {
    next(err);
  }
});

router.post("/", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const { name, phoneNumber, username } = req.body || {};
    if (!name || !phoneNumber || !username) {
      return res.status(400).json({ error: "name, phoneNumber, and username are required" });
    }

    const existingUsername = await prisma.user.findUnique({ where: { username } });
    if (existingUsername) {
      return res.status(409).json({ error: "username_taken" });
    }

    const employeeId = await generateUniqueEmployeeId();
    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    const employee = await prisma.employee.create({
      data: {
        employeeId,
        name,
        phoneNumber,
        user: {
          create: { username, passwordHash, role: "EMPLOYEE", mustChangePassword: true },
        },
      },
      include: { user: true },
    });

    res.status(201).json({
      employee: publicEmployee(employee, req.user.role),
      // Shown exactly once — the device token to put in the Android app,
      // and the portal login password. Neither is recoverable after this;
      // use the rotate/reset endpoints if either is lost.
      credentials: { username, temporaryPassword: tempPassword },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (req.user.role === "EMPLOYEE" && req.user.employee?.id !== id) {
      return res.status(403).json({ error: "forbidden" });
    }
    if (req.user.role !== "EMPLOYEE" && !MANAGER_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: "forbidden" });
    }

    const employee = await prisma.employee.findUnique({
      where: { id },
      include: { user: true },
    });
    if (!employee) return res.status(404).json({ error: "not_found" });

    res.json(publicEmployee(employee, req.user.role));
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { name, phoneNumber, active } = req.body || {};

    const employee = await prisma.employee.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(phoneNumber !== undefined ? { phoneNumber } : {}),
        ...(active !== undefined ? { active } : {}),
      },
      include: { user: true },
    });

    // Deactivating an employee locks their portal login too. Their call
    // history and recordings are untouched — this is a soft delete.
    if (active === false && employee.userId) {
      await prisma.user.update({ where: { id: employee.userId }, data: { active: false } });
    }
    if (active === true && employee.userId) {
      await prisma.user.update({ where: { id: employee.userId }, data: { active: true } });
    }

    res.json(publicEmployee(employee, req.user.role));
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "not_found" });
    next(err);
  }
});

// Full removal — distinct from PATCH { active: false }, which is the usual
// "soft delete" that keeps call history intact. Blocked once the employee
// has call history on record (CallLog.employeeId has no cascade) — the
// deactivate path is the right tool once there's real history to preserve.
router.delete("/:id", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const employee = await prisma.employee.findUnique({
      where: { id },
      include: { _count: { select: { calls: true } } },
    });
    if (!employee) return res.status(404).json({ error: "not_found" });

    if (employee._count.calls > 0) {
      return res.status(409).json({
        error: "has_call_history",
        message: "This employee has call history on record — deactivate them instead of deleting.",
      });
    }

    await prisma.employee.delete({ where: { id } });
    if (employee.userId) {
      await prisma.user.delete({ where: { id: employee.userId } }).catch(() => {});
    }
    res.status(204).end();
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "not_found" });
    next(err);
  }
});

// Issues a new device token and invalidates the old one immediately — for
// when a phone is lost/replaced or a token needs rotating.
router.post("/:id/regenerate-device-id", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const employeeId = await generateUniqueEmployeeId();
    const employee = await prisma.employee.update({
      where: { id },
      data: { employeeId },
      include: { user: true },
    });
    res.json(publicEmployee(employee, req.user.role));
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "not_found" });
    next(err);
  }
});

// DEVELOPER-only: force-reset an employee's portal password. Since password
// hashes are one-way, this is the only way a developer can help someone
// who's locked out — there is no "view password" endpoint anywhere, by
// design. Returns the new temporary password exactly once; it is never
// stored in retrievable form and can't be fetched again after this response.
router.post("/:id/reset-password", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const employee = await prisma.employee.findUnique({ where: { id }, include: { user: true } });
    if (!employee) return res.status(404).json({ error: "not_found" });
    if (!employee.user) return res.status(409).json({ error: "no_portal_login" });

    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    await prisma.user.update({
      where: { id: employee.user.id },
      data: { passwordHash, mustChangePassword: true, passwordChangedAt: null },
    });

    res.json({
      employee: publicEmployee({ ...employee, user: employee.user }, req.user.role),
      // Shown exactly once, same as at account creation.
      credentials: { username: employee.user.username, temporaryPassword: tempPassword },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
