const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { resolveRecordingPath } = require("../utils/fileStorage");
const { serializeCall } = require("../utils/serialize");
const { resolvePlayableRecording } = require("../utils/audioTranscode");

const router = express.Router();
router.use(requireAuth);

// EMPLOYEE always sees only their own calls, regardless of what filters
// they pass — BOSS and DEVELOPER can see and filter across everyone.
function scopedWhere(req) {
  if (req.user.role === "EMPLOYEE") {
    if (!req.user.employee) return { employeeId: -1 }; // no linked employee -> sees nothing
    return { employeeId: req.user.employee.id };
  }

  const where = {};
  if (req.query.employeeId) where.employeeId = Number(req.query.employeeId);
  if (req.query.missed !== undefined) where.missed = req.query.missed === "true";
  if (req.query.callType) where.callType = req.query.callType;
  // Lets the portal filter down to "calls with no recording attached" —
  // e.g. so someone reviewing calls doesn't have to open each one just to
  // find out whether a file exists.
  if (req.query.hasRecording !== undefined) {
    where.recordingPath = req.query.hasRecording === "true" ? { not: null } : null;
  }
  if (req.query.from || req.query.to) {
    where.callTimestampMs = {};
    if (req.query.from) where.callTimestampMs.gte = BigInt(req.query.from);
    if (req.query.to) where.callTimestampMs.lte = BigInt(req.query.to);
  }
  return where;
}

router.get("/", async (req, res, next) => {
  try {
    const pageSize = Math.min(Number(req.query.pageSize) || 50, 200);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const [calls, total] = await Promise.all([
      prisma.callLog.findMany({
        where: scopedWhere(req),
        include: { employee: { select: { id: true, name: true } } },
        orderBy: { callTimestampMs: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.callLog.count({ where: scopedWhere(req) }),
    ]);

    res.json({
      calls: calls.map(serializeCall),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const call = await prisma.callLog.findFirst({
      where: { id, ...scopedWhere(req) },
      include: {
        employee: { select: { id: true, name: true } },
        transcript: true,
        analysis: true,
      },
    });
    if (!call) return res.status(404).json({ error: "not_found" });
    res.json(serializeCall(call));
  } catch (err) {
    next(err);
  }
});

router.get("/:id/recording", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const call = await prisma.callLog.findFirst({ where: { id, ...scopedWhere(req) } });
    if (!call) return res.status(404).json({ error: "not_found" });
    if (!call.recordingPath) return res.status(404).json({ error: "no_recording" });

    // Some recorder apps (e.g. Cube ACR) save calls in formats no browser
    // can actually decode — most commonly AMR. resolvePlayableRecording
    // transcodes those to MP3 on first request and caches the result, so
    // playback works instead of the <audio> element silently doing nothing.
    let playable;
    try {
      playable = await resolvePlayableRecording(call.recordingPath, resolveRecordingPath);
    } catch (transcodeErr) {
      console.error(
        `[calls] couldn't prepare recording for call ${id} (${call.recordingPath}) for playback:`,
        transcodeErr.message
      );
      return res.status(500).json({
        error: "recording_unplayable",
        message:
          "This recording is in a format the server couldn't convert for browser playback. The original file is untouched on disk.",
      });
    }

    // res.sendFile (via Express's underlying `send`) already handles Range
    // requests correctly, which is what lets an <audio> element seek
    // instead of only playing from the start. That's true whether this is
    // the original file or a cached transcode — both are real files.
    res.sendFile(playable.absolutePath, {
      headers: { "Content-Type": playable.contentType },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
