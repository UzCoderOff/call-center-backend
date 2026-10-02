const express = require("express");
const multer = require("multer");
const prisma = require("../lib/prisma");
const { phoneKey } = require("../lib/phone");
const { events } = require("../lib/events");
const { INCOMING_DIR, incomingFilename, saveRecording, removeQuietly } = require("../utils/fileStorage");
const { reconcileFollowUps } = require("../services/followUp");
const { bearerToken, findDevice } = require("../middleware/deviceAuth");

const router = express.Router();

class SyncError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// The Android app posts one multipart request per sync: a "payload" text
// part (JSON, see call-center-agent/SyncWorker.kt for the exact shape) plus
// zero or more "recording" file parts, matched to payload.calls[] entries
// by filename. The payload part always comes first.
//
// That ordering is what lets the device be authenticated *before* any file
// is accepted: the first time a file part shows up, fileFilter checks the
// employeeId in the already-received payload. An unknown/inactive device
// gets a 401 with nothing written — the rest of the upload is read and
// discarded (multer drains it, so the phone sees a clean 401 rather than a
// dropped connection). Accepted files stream to disk in INCOMING_DIR, never
// into memory, and are only moved into the recordings folder once matched
// to a call.
//
// fieldSize is set explicitly (multer's default is 1MB) because a busy
// employee's payload can plausibly exceed 1MB.
function authenticateOnce(req) {
  if (!req.syncAuth) req.syncAuth = authenticate(req);
  return req.syncAuth;
}

// Two ways a phone can identify itself:
//   - the Android app: `Authorization: Bearer <device token>` from signing
//     in with the person's account (routes/device.js)
//   - the legacy agent: the employee's device token inside the payload
// Either way the person must be active and have "collect calls" switched on.
async function authenticate(req) {
  const rawPayload = req.body?.payload;
  if (!rawPayload) throw new SyncError(400, "payload_missing", "payload part missing (it must come before any recording)");

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    throw new SyncError(400, "bad_payload_json", "payload is not valid JSON");
  }
  if (!payload || !Array.isArray(payload.calls)) {
    throw new SyncError(400, "missing_fields", "calls missing/invalid");
  }

  let employee;
  let device = null;
  if (bearerToken(req)) {
    device = await findDevice(bearerToken(req));
    if (!device) throw new SyncError(401, "device_not_signed_in", "device not signed in or revoked");
    employee = device.user.employee;
    if (!employee) throw new SyncError(403, "no_employee_record", "this account has no employee record");
  } else {
    if (typeof payload.employeeId !== "string" || !payload.employeeId) {
      throw new SyncError(401, "missing_credentials", "no device token and no employeeId");
    }
    employee = await prisma.employee.findUnique({ where: { employeeId: payload.employeeId } });
    if (!employee) throw new SyncError(401, "unknown_employee", "employee not recognized");
  }

  // Rejections from here on are attributed to the employee in SyncLog, so
  // "this phone keeps trying but collection is off" shows on their page.
  const reject = (status, code, message) => {
    const err = new SyncError(status, code, message);
    err.employeeToken = employee.employeeId;
    err.deviceId = device?.id ?? null;
    return err;
  };
  if (!employee.active) throw reject(401, "inactive_employee", "employee is inactive");
  if (!employee.collectCalls) throw reject(403, "collection_disabled", "call collection is off for this employee");

  return { employee, device, payload };
}

// Waits out a moment when the database is busy (someone importing a big
// spreadsheet): SQLite lets one writer at a time, and a sync shouldn't fail
// — and be sent again from the phone — because of it.
const BUSY_CODES = ["P1008", "P2028", "P2034"];
async function withRetry(fn, tries = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const busy = BUSY_CODES.includes(err?.code) || /SQLITE_BUSY|database is locked/i.test(err?.message || "");
      if (!busy || attempt >= tries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
}

const upload = multer({
  // File names come from the phone as UTF-8 (recorders put contact names in
  // them, often in Cyrillic or with ʻ). multer's default, latin1, garbled
  // those, so the recording no longer matched its call and was thrown away.
  defParamCharset: "utf8",
  storage: multer.diskStorage({
    destination: INCOMING_DIR,
    filename: (req, file, cb) => cb(null, incomingFilename()),
  }),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB per recording — a long call in a lossless-ish format
    // As many as a batch can have calls (the app sends at most 400): a phone
    // that fell behind — Honor froze the app for a day — used to get "too
    // many recordings" for the same batch forever.
    files: 400,
    fieldSize: 10 * 1024 * 1024, // 10MB for the JSON "payload" text field
    // Only the payload is a text part; anything more is junk, refused
    // before it can fill memory (it arrives before the phone is checked).
    fields: 4,
    parts: 410,
  },
  fileFilter: (req, file, cb) => {
    authenticateOnce(req)
      .then(() => cb(null, true))
      .catch((err) => cb(err));
  },
});

// Records one sync attempt — success or failure, including ones that never
// got far enough to know which employee sent them. Never throws: a bug in
// logging must never take down the actual response to the device.
async function logSyncAttempt(fields) {
  try {
    await prisma.syncLog.create({ data: fields });
  } catch (err) {
    console.error("failed to write SyncLog row:", err);
  }
}

function describeError(err) {
  if (err instanceof SyncError) return { status: err.status, code: err.code, message: err.message };
  if (err instanceof multer.MulterError) {
    switch (err.code) {
      case "LIMIT_FIELD_VALUE":
        return { status: 413, code: err.code, message: "sync payload (JSON) too large" };
      case "LIMIT_FILE_SIZE":
        return { status: 413, code: err.code, message: "a recording file is too large" };
      case "LIMIT_FILE_COUNT":
        return { status: 413, code: err.code, message: "too many recordings in one batch" };
      default:
        return { status: 400, code: err.code, message: err.message || "upload rejected" };
    }
  }
  return { status: 500, code: "sync_failed", message: "internal error" };
}

function parseTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new SyncError(400, "bad_call_entry", "callTimestampMs must be a non-negative integer");
  }
  return BigInt(n);
}

function optionalInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

async function processSync({ employee, payload, files }) {
  const filesByName = new Map(files.map((f) => [f.originalname, f]));
  const syncedAtMs = BigInt(optionalInt(payload.syncedAtMs) ?? Date.now());

  const touchedKeys = new Set();
  const callIds = [];
  const recordingCallIds = [];

  for (const raw of payload.calls) {
    if (raw == null || raw.callLogId == null) {
      throw new SyncError(400, "bad_call_entry", "call entry without callLogId");
    }
    const deviceCallLogId = String(raw.callLogId);
    const callTimestampMs = parseTimestamp(raw.callTimestampMs);
    const missed = Boolean(raw.missed);
    const phoneNumber = raw.phoneNumber ? String(raw.phoneNumber) : "unknown";
    const key = phoneKey(phoneNumber);
    if (key) touchedKeys.add(key);

    let recordingUpdate = {};
    const file = raw.recordingFilename ? filesByName.get(raw.recordingFilename) : null;
    if (file) {
      recordingUpdate = {
        recordingFilename: raw.recordingFilename,
        recordingPath: saveRecording({
          employeeDbId: employee.id,
          deviceCallLogId,
          callTimestampMs,
          originalFilename: raw.recordingFilename,
          tempPath: file.path,
        }),
      };
      filesByName.delete(raw.recordingFilename);
    }

    const fields = {
      phoneNumber,
      phoneKey: key,
      callType: raw.callType ? String(raw.callType) : "unknown",
      missed,
      durationSeconds: Math.max(0, optionalInt(raw.durationSeconds) ?? 0),
      syncedAtMs,
    };

    const call = await withRetry(() => prisma.callLog.upsert({
      where: {
        employeeId_deviceCallLogId_callTimestampMs: { employeeId: employee.id, deviceCallLogId, callTimestampMs },
      },
      // On a retried/replayed batch, only overwrite recording info if we
      // actually received a file this time — never blank out a
      // previously-saved recording just because a later sync didn't
      // happen to include it again. Follow-up status is owned by
      // reconcileFollowUps below, never by the device.
      update: { ...fields, ...recordingUpdate },
      create: {
        employeeId: employee.id,
        deviceCallLogId,
        callTimestampMs,
        ...fields,
        ...recordingUpdate,
        followUp: missed ? (key ? "pending" : "no_number") : null,
      },
      select: { id: true },
    }));

    callIds.push(call.id);
    if (file) recordingCallIds.push(call.id);
  }

  // A failure here must not fail the sync: the calls themselves are saved,
  // and `npm run followups:rebuild` can recompute everything later.
  try {
    await reconcileFollowUps([...touchedKeys]);
  } catch (err) {
    console.error("follow-up reconciliation failed:", err);
  }

  // Recordings that matched no call in the payload are dropped — say so in
  // the server log, so a naming problem on some phone can be noticed.
  if (filesByName.size > 0) {
    console.warn(`sync: ${filesByName.size} recording(s) from employee ${employee.id} matched no call: ${[...filesByName.keys()].slice(0, 3).join(", ")}`);
  }

  events.emit("calls.synced", { employeeId: employee.id, callIds, recordingCallIds });

  return { received: callIds.length, recordingsSaved: recordingCallIds.length };
}

router.post("/sync", (req, res) => {
  upload.array("recording")(req, res, async (uploadErr) => {
    const files = req.files || [];
    let employeeToken = null;
    let deviceId = null;

    try {
      if (uploadErr) throw uploadErr;
      const { employee, device, payload } = await authenticateOnce(req);
      // SyncLog is keyed by the employee's legacy token whichever way the
      // phone authenticated, so sync health works the same for both.
      employeeToken = employee.employeeId;
      deviceId = device?.id ?? null;

      const result = await processSync({ employee, payload, files });

      await logSyncAttempt({
        employeeId: employeeToken,
        deviceId,
        ok: true,
        httpStatus: 200,
        callCount: result.received,
        recordingCount: result.recordingsSaved,
        payloadBytes: Buffer.byteLength(req.body.payload, "utf8"),
        appVersion: typeof payload.appVersion === "string" ? payload.appVersion.slice(0, 40) : null,
        integrityFlag: typeof payload.logIntegrity === "string" ? payload.logIntegrity.slice(0, 80) : null,
        missingEntries: optionalInt(payload.missingEntries),
        filesAccess: typeof payload.filesAccess === "boolean" ? payload.filesAccess : null,
      });

      res.json({ ok: true, ...result });
    } catch (err) {
      const { status, code, message } = describeError(err);
      if (status >= 500) console.error("sync error:", err);

      // Best effort: record which device this was, even for a rejected one.
      if (!employeeToken && err?.employeeToken) {
        employeeToken = err.employeeToken;
        deviceId = err.deviceId ?? null;
      }
      if (!employeeToken) {
        try {
          const parsed = JSON.parse(req.body?.payload || "null");
          if (typeof parsed?.employeeId === "string") employeeToken = parsed.employeeId.slice(0, 80);
        } catch {
          // unparseable payload — nothing to attribute it to
        }
      }

      await logSyncAttempt({
        employeeId: employeeToken,
        deviceId,
        ok: false,
        httpStatus: status,
        errorCode: code,
        errorMessage: (err?.message || message).slice(0, 300),
      });

      // The app reads the status code (and "message" for display). Internals
      // never leak to this unauthenticated endpoint: 500s get a generic message.
      res.status(status).json({ error: code, message });
    } finally {
      // Anything not moved into the recordings folder (unmatched files, or
      // everything on error) is just an orphaned temp file now.
      for (const f of files) {
        if (f.path) removeQuietly(f.path);
      }
    }
  });
});

module.exports = router;
