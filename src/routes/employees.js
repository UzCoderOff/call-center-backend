const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, requireRole, MANAGER_ROLES } = require("../middleware/auth");
const { hashPassword } = require("../lib/passwords");
const { generateUniqueEmployeeId } = require("../utils/employeeId");
const { generateTempPassword } = require("../lib/tempPassword");
const { parseId, badRequest } = require("../utils/params");
const { getSyncHealth } = require("../services/syncHealth");

const router = express.Router();
router.use(requireAuth);

const EMPLOYEE_INCLUDE = {
  user: true,
  office: { select: { id: true, name: true } },
  position: { select: { id: true, name: true } },
  reportTemplate: { select: { id: true, name: true } },
};

// Passwords are one-way bcrypt hashes (see lib/passwords.js) — nobody, not
// even a DEVELOPER, can ever recover or display someone's actual password.
// What a DEVELOPER *can* see is whether an account is still on the
// system-issued temporary password or has been changed since, via
// mustChangePassword/passwordChangedAt below.
//
// The legacy device token (Employee.employeeId — what the old
// manually-configured Android agent is set up with) is likewise
// DEVELOPER-only: anyone holding it can submit calls as that employee. It
// goes out as `deviceToken` so it can't be confused with the numeric `id`.
function publicEmployee(employee, viewerRole, sync) {
  const base = {
    id: employee.id,
    name: employee.name,
    phoneNumber: employee.phoneNumber,
    active: employee.active,
    username: employee.user?.username ?? null,
    office: employee.office ?? null,
    position: employee.position ?? null,
    collectCalls: employee.collectCalls,
    autoReport: employee.autoReport,
    alsoForm: employee.alsoForm,
    calendarAccess: employee.calendarAccess,
    workKind: employee.workKind,
    workDays: employee.workDays,
    holidaysOff: employee.holidaysOff,
    reportTemplate: employee.reportTemplate ?? null,
    createdAt: employee.createdAt,
  };
  if (sync !== undefined) base.sync = sync;
  if (viewerRole === "DEVELOPER") {
    base.deviceToken = employee.employeeId;
    if (employee.user) {
      base.passwordStatus = {
        mustChangePassword: employee.user.mustChangePassword,
        passwordChangedAt: employee.user.passwordChangedAt,
      };
    }
  }
  return base;
}

function cleanString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} is required`);
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// undefined -> "not given"; null/"" -> "clear it"; otherwise a valid id.
function optionalId(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return parseId(value, field);
}

const CALENDAR_ACCESS = ["none", "view", "book"];
const WORK_KINDS = ["auto", "client", "office"];
const { normalizePattern } = require("../services/workdays");

// The job-related settings shared by create and update.
function workSettings(body) {
  const data = {};
  const officeId = optionalId(body.officeId, "officeId");
  const positionId = optionalId(body.positionId, "positionId");
  const reportTemplateId = optionalId(body.reportTemplateId, "reportTemplateId");
  if (officeId !== undefined) data.officeId = officeId;
  if (positionId !== undefined) data.positionId = positionId;
  if (reportTemplateId !== undefined) data.reportTemplateId = reportTemplateId;
  if (body.collectCalls !== undefined) {
    if (typeof body.collectCalls !== "boolean") throw badRequest("collectCalls must be true or false");
    data.collectCalls = body.collectCalls;
  }
  if (body.autoReport !== undefined) {
    if (typeof body.autoReport !== "boolean") throw badRequest("autoReport must be true or false");
    data.autoReport = body.autoReport;
  }
  if (body.alsoForm !== undefined) {
    if (typeof body.alsoForm !== "boolean") throw badRequest("alsoForm must be true or false");
    data.alsoForm = body.alsoForm;
  }
  if (body.calendarAccess !== undefined) {
    if (!CALENDAR_ACCESS.includes(body.calendarAccess)) throw badRequest("invalid calendarAccess");
    data.calendarAccess = body.calendarAccess;
  }
  // What Natijalar measures them on (see schema: Employee.workKind).
  if (body.workKind !== undefined) {
    if (!WORK_KINDS.includes(body.workKind)) throw badRequest("invalid workKind");
    data.workKind = body.workKind;
  }
  // When they work: weekdays ("123456") and whether holidays are days off.
  if (body.workDays !== undefined) {
    const pattern = normalizePattern(body.workDays);
    if (!pattern) throw badRequest("invalid workDays");
    data.workDays = pattern;
  }
  if (body.holidaysOff !== undefined) {
    if (typeof body.holidaysOff !== "boolean") throw badRequest("holidaysOff must be true or false");
    data.holidaysOff = body.holidaysOff;
  }
  return data;
}

// BOSS and DEVELOPER can both see the staff list and each person's page —
// BOSS is read-only from here down. Only DEVELOPER can add/remove people or
// change their settings, sign out their phones, or reset a password.
router.get("/", requireRole(...MANAGER_ROLES), async (req, res, next) => {
  try {
    const employees = await prisma.employee.findMany({
      include: EMPLOYEE_INCLUDE,
      orderBy: { name: "asc" },
    });
    const health = await getSyncHealth(employees.filter((e) => e.collectCalls));
    res.json(employees.map((e) => publicEmployee(e, req.user.role, health.get(e.id) ?? null)));
  } catch (err) {
    next(err);
  }
});

router.post("/", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = cleanString(body.name, "name");
    const username = cleanString(body.username, "username");
    const settings = workSettings(body);

    // A position is a preset: anything not chosen explicitly comes from it.
    if (settings.positionId) {
      const position = await prisma.position.findUnique({ where: { id: settings.positionId } });
      if (!position) throw badRequest("unknown position");
      if (settings.collectCalls === undefined) settings.collectCalls = position.collectCalls;
      if (settings.autoReport === undefined) settings.autoReport = position.autoReport;
      if (settings.alsoForm === undefined) settings.alsoForm = position.alsoForm;
      if (settings.calendarAccess === undefined) settings.calendarAccess = position.calendarAccess;
      if (settings.reportTemplateId === undefined) settings.reportTemplateId = position.reportTemplateId;
      if (settings.workDays === undefined) settings.workDays = position.workDays;
      if (settings.holidaysOff === undefined) settings.holidaysOff = position.holidaysOff;
    }

    const existingUsername = await prisma.user.findUnique({ where: { username } });
    if (existingUsername) {
      return res.status(409).json({ error: "username_taken" });
    }

    const employeeId = await generateUniqueEmployeeId();
    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    // Prisma doesn't allow raw foreign-key ids next to a nested
    // `user: { create }`, so the links are written as `connect`s.
    const connect = (id) => (id ? { connect: { id } } : undefined);
    const employee = await prisma.employee.create({
      data: {
        employeeId,
        name,
        phoneNumber: optionalString(body.phoneNumber),
        collectCalls: settings.collectCalls ?? false,
        autoReport: settings.autoReport ?? false,
        alsoForm: settings.alsoForm ?? false,
        calendarAccess: settings.calendarAccess ?? "none",
        workKind: settings.workKind ?? "auto",
        // Without a position: call-center staff (calls collected) work every
        // day, holidays included; everyone else Monday–Saturday.
        workDays: settings.workDays ?? (settings.collectCalls ? "1234567" : "123456"),
        holidaysOff: settings.holidaysOff ?? !settings.collectCalls,
        office: connect(settings.officeId),
        position: connect(settings.positionId),
        reportTemplate: connect(settings.reportTemplateId),
        user: {
          create: { username, passwordHash, role: "EMPLOYEE", mustChangePassword: true },
        },
      },
      include: EMPLOYEE_INCLUDE,
    });

    res.status(201).json({
      employee: publicEmployee(employee, req.user.role),
      // The portal login password is shown exactly once — it isn't
      // recoverable after this; use reset-password if it's lost. The same
      // username/password signs in to the Android app.
      credentials: { username, temporaryPassword: tempPassword },
    });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "username_taken" });
    if (err.code === "P2003" || err.code === "P2025") return res.status(400).json({ error: "invalid_reference" });
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const isManager = MANAGER_ROLES.includes(req.user.role);
    if (!isManager && req.user.employee?.id !== id) {
      return res.status(403).json({ error: "forbidden" });
    }

    const employee = await prisma.employee.findUnique({ where: { id }, include: EMPLOYEE_INCLUDE });
    if (!employee) return res.status(404).json({ error: "not_found" });

    const health = employee.collectCalls ? (await getSyncHealth([employee])).get(employee.id) : null;
    const body = publicEmployee(employee, req.user.role, health);

    if (isManager) {
      // Phones signed in to the app with this person's account.
      body.devices = employee.userId
        ? await prisma.device.findMany({
            where: { userId: employee.userId, revokedAt: null },
            orderBy: { lastSeenAt: "desc" },
            select: { id: true, label: true, appVersion: true, createdAt: true, lastSeenAt: true },
          })
        : [];

      // The raw sync attempt history, for diagnosing a phone that stopped
      // sending.
      body.recentSyncs = await prisma.syncLog.findMany({
        where: { employeeId: employee.employeeId },
        orderBy: { createdAt: "desc" },
        take: 15,
        select: {
          id: true,
          ok: true,
          httpStatus: true,
          errorCode: true,
          errorMessage: true,
          callCount: true,
          recordingCount: true,
          appVersion: true,
          integrityFlag: true,
          missingEntries: true,
          createdAt: true,
        },
      });
    }

    res.json(body);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const body = req.body || {};
    const { name, phoneNumber, active } = body;
    if (active !== undefined && typeof active !== "boolean") throw badRequest("active must be true or false");

    const employee = await prisma.employee.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name: cleanString(name, "name") } : {}),
        ...(phoneNumber !== undefined ? { phoneNumber: optionalString(phoneNumber) } : {}),
        ...(active !== undefined ? { active } : {}),
        ...workSettings(body),
      },
      include: EMPLOYEE_INCLUDE,
    });

    // Deactivating an employee locks their portal login and app too. Their
    // call history, reports and recordings are untouched — a soft delete.
    if (active !== undefined && employee.userId) {
      await prisma.user.update({ where: { id: employee.userId }, data: { active } });
    }

    res.json(publicEmployee(employee, req.user.role));
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "not_found" });
    if (err.code === "P2003") return res.status(400).json({ error: "invalid_reference" });
    next(err);
  }
});

// Full removal — distinct from PATCH { active: false }, which is the usual
// "soft delete" that keeps history intact. Blocked once the employee has
// call history on record (CallLog.employeeId has no cascade) — the
// deactivate path is the right tool once there's real history to preserve.
router.delete("/:id", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const employee = await prisma.employee.findUnique({
      where: { id },
      include: { _count: { select: { calls: true, reports: true } } },
    });
    if (!employee) return res.status(404).json({ error: "not_found" });

    if (employee._count.calls > 0 || employee._count.reports > 0) {
      return res.status(409).json({
        error: "has_call_history",
        message: "This employee has calls or reports on record — deactivate them instead of deleting.",
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

// Signs a phone out of the app (lost phone, replaced phone): its token stops
// working immediately, for syncing and for the in-app portal.
router.delete("/:id/devices/:deviceId", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const employee = await prisma.employee.findUnique({ where: { id: parseId(req.params.id) } });
    if (!employee?.userId) return res.status(404).json({ error: "not_found" });
    const result = await prisma.device.updateMany({
      where: { id: parseId(req.params.deviceId, "deviceId"), userId: employee.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) return res.status(404).json({ error: "not_found" });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Issues a new legacy device token and invalidates the old one immediately.
router.post("/:id/regenerate-device-id", requireRole("DEVELOPER"), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const employeeId = await generateUniqueEmployeeId();
    const employee = await prisma.employee.update({
      where: { id },
      data: { employeeId },
      include: EMPLOYEE_INCLUDE,
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
    const id = parseId(req.params.id);
    const employee = await prisma.employee.findUnique({ where: { id }, include: EMPLOYEE_INCLUDE });
    if (!employee) return res.status(404).json({ error: "not_found" });
    if (!employee.user) return res.status(409).json({ error: "no_portal_login" });

    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);

    // A reset usually means lost access or a lost phone: every existing
    // login — browsers and phones signed in to the app — stops working.
    const now = new Date();
    const [user] = await prisma.$transaction([
      prisma.user.update({
        where: { id: employee.user.id },
        data: { passwordHash, mustChangePassword: true, passwordChangedAt: null, sessionsValidAfter: now },
      }),
      prisma.device.updateMany({ where: { userId: employee.user.id, revokedAt: null }, data: { revokedAt: now } }),
    ]);

    res.json({
      employee: publicEmployee({ ...employee, user }, req.user.role),
      // Shown exactly once, same as at account creation.
      credentials: { username: user.username, temporaryPassword: tempPassword },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
