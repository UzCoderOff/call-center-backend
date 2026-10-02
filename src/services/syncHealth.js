const prisma = require("../lib/prisma");

// "Is this person's phone actually sending us data?" — derived from SyncLog.
// This is what surfaces a phone that silently stopped syncing (battery
// optimisation killed the app, wrong server URL, rotated token…) in the
// portal, instead of someone noticing days later that calls are missing.

// With the app syncing hourly, this long without a successful sync means
// something is wrong (or the phone has been off).
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const INTEGRITY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

// "Is this phone recording calls?" The app can't record calls itself
// (Android doesn't let apps do that); it finds the files the phone's own
// recorder makes. So a phone whose automatic call recording is off — or
// where the app may not read files — sends calls without recordings. Over
// the last week: answered calls long enough to have a recording, and how
// many of them came with one.
const RECORDING_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const RECORDABLE_MIN_SECONDS = 10;
const RECORDING_MIN_CALLS = 3; // fewer than this: too early to tell
const RECORDING_OK_SHARE = 0.7;

// employeeIds: Employee.id. Returns Map<Employee.id, recordings>.
async function getRecordingHealth(employees) {
  if (employees.length === 0) return new Map();
  const ids = employees.map((e) => e.id);
  const tokens = employees.map((e) => e.employeeId).filter(Boolean);
  const since = BigInt(Date.now() - RECORDING_LOOKBACK_MS);
  const answered = { employeeId: { in: ids }, missed: false, durationSeconds: { gte: RECORDABLE_MIN_SECONDS }, callTimestampMs: { gte: since } };
  const [calls, recorded, last, access] = await Promise.all([
    prisma.callLog.groupBy({ by: ["employeeId"], where: answered, _count: { _all: true } }),
    prisma.callLog.groupBy({ by: ["employeeId"], where: { ...answered, recordingPath: { not: null } }, _count: { _all: true } }),
    prisma.callLog.groupBy({ by: ["employeeId"], where: { employeeId: { in: ids }, recordingPath: { not: null } }, _max: { callTimestampMs: true } }),
    // What the app said about file access in its latest sync that told us.
    tokens.length
      ? Promise.all(tokens.map((t) => prisma.syncLog.findFirst({ where: { employeeId: t, ok: true, filesAccess: { not: null } }, orderBy: { createdAt: "desc" }, select: { employeeId: true, filesAccess: true } })))
      : [],
  ]);
  const count = (rows) => new Map(rows.map((r) => [r.employeeId, r._count._all]));
  const callsBy = count(calls);
  const recordedBy = count(recorded);
  const lastBy = new Map(last.map((r) => [r.employeeId, r._max.callTimestampMs]));
  const accessBy = new Map(access.filter(Boolean).map((r) => [r.employeeId, r.filesAccess]));

  const out = new Map();
  for (const e of employees) {
    const n = callsBy.get(e.id) || 0;
    const m = recordedBy.get(e.id) || 0;
    const filesAccess = accessBy.has(e.employeeId) ? accessBy.get(e.employeeId) : null;
    let status = "unknown";
    if (filesAccess === false) status = "noAccess";
    else if (n >= RECORDING_MIN_CALLS) status = m === 0 ? "none" : m / n < RECORDING_OK_SHARE ? "partial" : "ok";
    else if (m > 0) status = "ok";
    const lastAt = lastBy.get(e.id);
    out.set(e.id, {
      status, // "ok" | "partial" | "none" | "noAccess" | "unknown"
      calls7d: n,
      recorded7d: m,
      lastRecordingAt: lastAt != null ? Number(lastAt) : null,
      filesAccess,
    });
  }
  return out;
}

// employees: [{ id, employeeId (device token) }]
// Returns Map<Employee.id, health>.
async function getSyncHealth(employees) {
  const tokens = employees.map((e) => e.employeeId);
  if (tokens.length === 0) return new Map();

  const [latest, integrity, recordings] = await Promise.all([
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
    getRecordingHealth(employees),
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
      recordings: recordings.get(e.id),
    });
  }
  return result;
}

module.exports = { getSyncHealth, getRecordingHealth, STALE_AFTER_MS };
