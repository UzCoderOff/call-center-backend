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
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB per recording
    files: 50, // generous ceiling per sync batch
  },
});

// The Android app posts one multipart request per sync: a "payload" text
// part (JSON, see call-center-agent/SyncWorker.kt for the exact shape) plus
// zero or more "recording" file parts, matched to payload.calls[] entries
// by filename.
router.post("/sync", upload.array("recording"), async (req, res) => {
  // The app never reads the response body — only whether the request
  // succeeded — so every failure path below can stay terse. It's still a
  // real status code and JSON body (not a silently dropped connection) so
  // this endpoint is debuggable from a browser or curl.
  try {
    let payload;
    try {
      payload = JSON.parse(req.body?.payload || "");
    } catch {
      return res.status(401).json({ error: "unauthorized" });
    }

    const { employeeId, calls } = payload;
    if (!employeeId || !Array.isArray(calls)) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const employee = await prisma.employee.findUnique({ where: { employeeId } });
    if (!employee || !employee.active) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const filesByName = new Map((req.files || []).map((f) => [f.originalname, f]));

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

    res.json({ ok: true, received: calls.length, recordingsSaved: savedRecordings });
  } catch (err) {
    console.error("sync error:", err);
    // Deliberately not next(err) -> errorHandler here: keep this endpoint's
    // failure shape simple and consistent for the device, and make sure a
    // bug in here never leaks internals to an unauthenticated caller.
    res.status(500).json({ error: "sync_failed" });
  }
});

module.exports = router;
