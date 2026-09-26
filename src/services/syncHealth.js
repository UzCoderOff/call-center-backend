const prisma = require("../lib/prisma");

// "Is this person's phone actually sending us data?" — derived from SyncLog.
// This is what surfaces a phone that silently stopped syncing (battery
// optimisation killed the app, wrong server URL, rotated token…) in the
// portal, instead of someone noticing days later that calls are missing.

// With the app syncing hourly, this long without a successful sync means
// something is wrong (or the phone has been off).
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const INTEGRITY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

// employees: [{ id, employeeId (device token) }]
// Returns Map<Employee.id, health>.
async function getSyncHealth(employees) {
  const tokens = employees.map((e) => e.employeeId);
  if (tokens.length === 0) return new Map();

  const [latest, integrity] = await Promise.all([
    prisma.syncLog.groupBy({
      by: ["employeeId", "ok"],
      where: { employeeId: { in: tokens } },
      _max: { createdAt: true },
    }),
    prisma.syncLog.groupBy({
      by: ["employeeId"],
      where: {
        employeeId: { in: tokens },
        missingEntries: { gt: 0 },
        createdAt: { gte: new Date(Date.now() - INTEGRITY_LOOKBACK_MS) },
      },
      _sum: { missingEntries: true },
    }),
  ]);

  const lastOk = new Map();
  const lastFail = new Map();
  for (const row of latest) {
    (row.ok ? lastOk : lastFail).set(row.employeeId, row._max.createdAt);
  }
  const missing = new Map(integrity.map((row) => [row.employeeId, row._sum.missingEntries || 0]));

  // Only fetch the error text for phones whose most recent attempt failed.
  const failingTokens = tokens.filter((t) => lastFail.has(t) && (!lastOk.has(t) || lastFail.get(t) > lastOk.get(t)));
  const failures = failingTokens.length
    ? await Promise.all(
        failingTokens.map((t) =>
          prisma.syncLog.findFirst({
            where: { employeeId: t, ok: false },
            orderBy: { createdAt: "desc" },
            select: { employeeId: true, errorCode: true, errorMessage: true, httpStatus: true, createdAt: true },
          })
        )
      )
    : [];
  const lastError = new Map(failures.filter(Boolean).map((f) => [f.employeeId, f]));

  const now = Date.now();
  const result = new Map();
  for (const e of employees) {
    const okAt = lastOk.get(e.employeeId) || null;
    const failAt = lastFail.get(e.employeeId) || null;
    const error = lastError.get(e.employeeId) || null;
    let state = "never";
    if (error) state = "failing";
    else if (okAt) state = now - okAt.getTime() > STALE_AFTER_MS ? "stale" : "ok";

    result.set(e.id, {
      state, // "ok" | "stale" | "failing" | "never"
      lastSyncAt: okAt,
      lastAttemptAt: okAt && failAt ? (okAt > failAt ? okAt : failAt) : okAt || failAt,
      lastError: error
        ? { code: error.errorCode, message: error.errorMessage, httpStatus: error.httpStatus, at: error.createdAt }
        : null,
      missingEntries7d: missing.get(e.employeeId) || 0,
    });
  }
  return result;
}

module.exports = { getSyncHealth, STALE_AFTER_MS };
