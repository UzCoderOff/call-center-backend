const express = require("express");
const multer = require("multer");
const prisma = require("../lib/prisma");
const { saveRecording } = require("../utils/fileStorage");

const router = express.Router();

// Recordings are buffered in memory rather than streamed straight to disk so
// that an unrecognized employeeId can be rejected cleanly with nothing ever
// written — no orphan temp files to clean up. Call recordings from a phone
// are small enough (single-digit MB, typically) that this is fine for the
// scale this system runs at; revisit if that ever stops being true.
//
// fieldSize is set explicitly (multer's default is 1MB) because the
// "payload" part is JSON text, not a file, and a busy employee's first sync
// (48h call-log lookback, see SyncWorker.kt) can plausibly produce a
// payload over 1MB. Hitting that default was the most likely cause of the
// "stuck on Syncing forever" bug: multer would throw, the error was never
// caught below, Express fell back to a bare 500, and the Android client
// treated that as transient and retried forever with no cap.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB per recording
    files: 50, // generous ceiling per sync batch
    fieldSize: 10 * 1024 * 1024, // 10MB for the JSON "payload" text field
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

// Maps a multer/busboy error to an HTTP status + stable code + message
// that's actually useful on the device end and in SyncLog, instead of a
// bare 500 that gives no hint what went wrong.
function describeUploadError(err) {
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
  return { status: 400, code: "upload_error", message: err.message || "upload rejected" };
}

// The Android app posts one multipart request per sync: a "payload" text
// part (JSON, see call-center-agent/SyncWorker.kt for the exact shape) plus
// zero or more "recording" file parts, matched to payload.calls[] entries
// by filename.
//
// upload.array(...) is invoked manually (rather than as router-level
// middleware) so a multer error can be caught here, turned into a real
// status code + message, and logged to SyncLog — instead of falling
// through to the generic error handler as an unexplained 500.
router.post("/sync", (req, res) => {
  upload.array("recording")(req, res, async (uploadErr) => {
    if (uploadErr) {
      const { status, code, message } = describeUploadError(uploadErr);
      console.error("sync upload error:", uploadErr);
      await logSyncAttempt({
        employeeId: null,
        ok: false,
        httpStatus: status,
        errorCode: code,
        errorMessage: message,
      });
      return res.status(status).json({ error: code, message });
    }

    // The app only reads the response's status code, not its body — but the
    // body is still real JSON with a stable "error" code (not just a status
    // number) so this endpoint stays debuggable from a browser or curl, and
    // so an improved client can eventually show the "message" to a human.
    let payload;
    let employeeIdRaw = null;
    try {
      const raw = req.body?.payload || "";
      payload = JSON.parse(raw);
      employeeIdRaw = typeof payload?.employeeId === "string" ? payload.employeeId : null;
    } catch {
      await logSyncAttempt({
        employeeId: null,
        ok: false,
        httpStatus: 401,
        errorCode: "bad_payload_json",
        errorMessage: "payload field was missing or not valid JSON",
      });
      return res.status(401).json({ error: "unauthorized", message: "bad payload" });
    }

    try {
      const { employeeId, calls } = payload;
      if (!employeeId || !Array.isArray(calls)) {
        await logSyncAttempt({
          employeeId: employeeIdRaw,
          ok: false,
          httpStatus: 401,
          errorCode: "missing_fields",
          errorMessage: "employeeId or calls missing/invalid",
        });
        return res.status(401).json({ error: "unauthorized", message: "missing fields" });
      }

      const employee = await prisma.employee.findUnique({ where: { employeeId } });
      if (!employee || !employee.active) {
        await logSyncAttempt({
          employeeId,
          ok: false,
          httpStatus: 401,
          errorCode: "unknown_or_inactive_employee",
          errorMessage: !employee ? "no such employeeId" : "employee inactive",
          callCount: calls.length,
        });
        return res.status(401).json({ error: "unauthorized", message: "employee not recognized or inactive" });
      }

      const filesByName = new Map((req.files || []).map((f) => [f.originalname, f]));
      const payloadBytes = Buffer.byteLength(req.body?.payload || "", "utf8");

      let savedRecordings = 0;
      for (const call of calls) {
        const deviceCallLogId = String(call.callLogId);

        let recordingUpdate = {};
        if (call.recordingFilename) {
          const file = filesByName.get(call.recordingFilename);
          if (file) {
            const relativePath = saveRecording({
              employeeId,
              deviceCallLogId,
              originalFilename: call.recordingFilename,
              buffer: file.buffer,
            });
            recordingUpdate = {
              recordingFilename: call.recordingFilename,
              recordingPath: relativePath,
            };
            savedRecordings += 1;
          }
        }

        const data = {
          employeeId: employee.id,
          deviceCallLogId,
          phoneNumber: call.phoneNumber ?? "unknown",
          callType: call.callType ?? "unknown",
          missed: Boolean(call.missed),
          callTimestampMs: BigInt(call.callTimestampMs ?? 0),
          durationSeconds: Number(call.durationSeconds ?? 0),
          logIntegrityFlag: payload.logIntegrity ?? null,
          syncedAtMs: BigInt(payload.syncedAtMs ?? Date.now()),
          ...recordingUpdate,
        };

        await prisma.callLog.upsert({
          where: {
            employeeId_deviceCallLogId: { employeeId: employee.id, deviceCallLogId },
          },
          // On a retried/replayed batch, only overwrite recording info if we
          // actually received a file this time — never blank out a
          // previously-saved recording just because a later sync didn't
          // happen to include it again.
          update: {
            phoneNumber: data.phoneNumber,
            callType: data.callType,
            missed: data.missed,
            durationSeconds: data.durationSeconds,
            logIntegrityFlag: data.logIntegrityFlag,
            syncedAtMs: data.syncedAtMs,
            ...recordingUpdate,
          },
          create: data,
        });
      }

      await logSyncAttempt({
        employeeId,
        ok: true,
        httpStatus: 200,
        callCount: calls.length,
        recordingCount: savedRecordings,
        payloadBytes,
      });

      res.json({ ok: true, received: calls.length, recordingsSaved: savedRecordings });
    } catch (err) {
      console.error("sync error:", err);
      await logSyncAttempt({
        employeeId: employeeIdRaw,
        ok: false,
        httpStatus: 500,
        errorCode: "sync_failed",
        errorMessage: err?.message?.slice(0, 300) || "unknown error",
      });
      // Deliberately not next(err) -> errorHandler here: keep this endpoint's
      // failure shape simple and consistent for the device, and make sure a
      // bug in here never leaks internals to an unauthenticated caller.
      res.status(500).json({ error: "sync_failed", message: "internal error" });
    }
  });
});

module.exports = router;
