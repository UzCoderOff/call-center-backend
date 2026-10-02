const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isManager } = require("../middleware/auth");
const { resolveRecordingPath } = require("../utils/fileStorage");
const { resolvePlayableRecording } = require("../utils/audioTranscode");
const { badRequest, parseMs, parseId } = require("../utils/params");
const { clientIndexFor } = require("../lib/clientAccess");
const { parseJobs, isCoordinator } = require("../lib/jobs");
const {
  FOLLOW_UP_WINDOW_MS,
  NEEDS_CALLBACK_STATUSES,
  reconcileFollowUps,
} = require("../services/followUp");

const router = express.Router();
router.use(requireAuth);

const FOLLOW_UP_STATUSES = ["pending", "attempted", "called_back", "client_called_again", "handled", "no_number"];

// Who may see which calls: BOSS/DEVELOPER see everyone's; anyone else
// only ever their own, whatever they ask for (a lawyer: none).
function accessWhere(req) {
  if (!isManager(req.user)) {
    return { employeeId: req.user.employee ? req.user.employee.id : -1 }; // no linked employee -> sees nothing
  }
  return {};
}

// Opening one call (and its recording): also, for a coordinator, any call
// with a client they look after — the whole history matters after the
// contract (the operator's first calls, the lawyer's). Lists stay their own.
async function viewWhere(req) {
  const own = accessWhere(req);
  if (isManager(req.user) || !isCoordinator(req.user.employee)) return own;
  const phones = await prisma.clientPhone.findMany({
    where: { phoneKey: { not: null }, client: { cases: { some: { coordinatorId: req.user.employee.id } } } },
    select: { phoneKey: true },
  });
  const keys = [...new Set(phones.map((p) => p.phoneKey))];
  return keys.length ? { OR: [own, { phoneKey: { in: keys } }] } : own;
}

// List filters, applied on top of accessWhere for every role.
function filterWhere(req) {
  const q = req.query;
  const where = {};

  if (q.employeeId && isManager(req.user)) where.employeeId = parseId(q.employeeId, "employeeId");
  // ?jobs=call_center,coordinator — whose phones (Employee.job). The portal
  // shows the call center by default; the others are a tap away.
  const jobs = parseJobs(q.jobs);
  if (jobs && isManager(req.user) && !q.employeeId) where.employee = { job: { in: jobs } };
  if (q.missed !== undefined) where.missed = q.missed === "true";
  if (q.callType) where.callType = String(q.callType);
  // Lets the portal filter down to "calls with no recording attached" —
  // e.g. so someone reviewing calls doesn't have to open each one just to
  // find out whether a file exists.
  if (q.hasRecording !== undefined) {
    where.recordingPath = q.hasRecording === "true" ? { not: null } : null;
  }
  if (q.followUp) {
    const statuses = String(q.followUp).split(",").filter((s) => FOLLOW_UP_STATUSES.includes(s));
    if (statuses.length === 0) throw badRequest("unknown followUp status");
    where.missed = true;
    where.followUp = { in: statuses };
  }
  // The "call these people back" list: still unreached, and recent enough
  // that calling back still makes sense.
  if (q.needsCallback === "true") {
    where.missed = true;
    where.followUp = { in: NEEDS_CALLBACK_STATUSES };
    where.callTimestampMs = { gte: BigInt(Date.now() - FOLLOW_UP_WINDOW_MS) };
  }
  if (q.phone) {
    const digits = String(q.phone).replace(/\D/g, "");
    if (digits.length >= 3) where.phoneKey = { contains: digits.length > 9 ? digits.slice(-9) : digits };
  }

  const from = parseMs(q.from, "from");
  const to = parseMs(q.to, "to");
  if (from != null || to != null) {
    where.callTimestampMs = {
      ...(where.callTimestampMs || {}),
      ...(from != null ? { gte: BigInt(from) } : {}),
      ...(to != null ? { lte: BigInt(to) } : {}),
    };
  }
  return where;
}

const LINKED_CALL_SELECT = {
  id: true,
  callType: true,
  callTimestampMs: true,
  durationSeconds: true,
  employee: { select: { id: true, name: true } },
};

const LIST_INCLUDE = {
  employee: { select: { id: true, name: true } },
  followUpCall: { select: LINKED_CALL_SELECT },
};

// ?sort=longest lists the longest conversations first (the dashboard's
// "talk time" tile opens this); the default is newest first.
const SORTS = {
  newest: [{ callTimestampMs: "desc" }],
  longest: [{ durationSeconds: "desc" }, { callTimestampMs: "desc" }],
};

router.get("/", async (req, res, next) => {
  try {
    const pageSize = Math.min(Number(req.query.pageSize) || 50, 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const orderBy = SORTS[req.query.sort] || SORTS.newest;
    const where = { ...filterWhere(req), ...accessWhere(req) };

    const [calls, total, sums] = await Promise.all([
      prisma.callLog.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.callLog.count({ where }),
      prisma.callLog.aggregate({ where, _sum: { durationSeconds: true } }),
    ]);

    // The client behind each number, when the number is in the clients database.
    const clients = await clientIndexFor(req.user, calls.map((c) => c.phoneKey));
    res.json({
      calls: calls.map((c) => ({ ...c, client: clients.get(c.phoneKey) || null })),
      // Totals for the whole filtered list, not just this page.
      summary: { total, talkSeconds: sums._sum.durationSeconds || 0 },
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (err) {
    next(err);
  }
});

async function loadCallDetail(req, id) {
  const visible = await viewWhere(req);
  const call = await prisma.callLog.findFirst({
    where: { id, ...visible },
    include: {
      ...LIST_INCLUDE,
      transcript: true,
      analysis: true,
      // For a callback: which missed calls this one resolved.
      resolvesMissed: { select: { id: true, callTimestampMs: true, employee: { select: { id: true, name: true } } } },
      followUpMarkedBy: { select: { id: true, username: true, employee: { select: { name: true } } } },
    },
  });
  if (!call) return null;

  // Everything else on record with this caller — the start of a per-client
  // history. Same access rules as everywhere else.
  const history = call.phoneKey
    ? await prisma.callLog.findMany({
        where: { phoneKey: call.phoneKey, id: { not: call.id }, ...visible },
        select: { ...LINKED_CALL_SELECT, missed: true, followUp: true },
        orderBy: { callTimestampMs: "desc" },
        take: 20,
      })
    : [];

  const clients = await clientIndexFor(req.user, [call.phoneKey]);
  return { ...call, history, client: clients.get(call.phoneKey) || null };
}

router.get("/:id", async (req, res, next) => {
  try {
    const call = await loadCallDetail(req, parseId(req.params.id));
    if (!call) return res.status(404).json({ error: "not_found" });
    res.json(call);
  } catch (err) {
    next(err);
  }
});

// Manually mark a missed call as handled (the caller was reached some
// other way — Telegram, in person, a personal phone) or undo that.
// Employees can do this for their own calls; managers for anyone's.
router.patch("/:id/follow-up", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const { handled } = req.body || {};
    if (typeof handled !== "boolean") throw badRequest("handled must be true or false");

    const call = await prisma.callLog.findFirst({ where: { id, ...accessWhere(req) } });
    if (!call) return res.status(404).json({ error: "not_found" });
    if (!call.missed) return res.status(409).json({ error: "not_a_missed_call" });
    if (!call.phoneKey) return res.status(409).json({ error: "no_number" });

    if (handled) {
      if (!NEEDS_CALLBACK_STATUSES.includes(call.followUp)) {
        return res.status(409).json({ error: "already_resolved" });
      }
      await prisma.callLog.update({
        where: { id },
        data: { followUp: "handled", followUpMarkedById: req.user.id, followUpMarkedAt: new Date() },
      });
    } else {
      if (call.followUp !== "handled") return res.status(409).json({ error: "not_marked_handled" });
      if (!isManager(req.user) && call.followUpMarkedById !== req.user.id) {
        return res.status(403).json({ error: "forbidden" });
      }
      await prisma.callLog.update({
        where: { id },
        data: { followUp: "pending", followUpMarkedById: null, followUpMarkedAt: null },
      });
    }

    // Re-derive from the actual call history (e.g. undoing "handled" on a
    // call that did get an unanswered callback attempt -> "attempted").
    await reconcileFollowUps([call.phoneKey]);
    res.json(await loadCallDetail(req, id));
  } catch (err) {
    next(err);
  }
});

router.get("/:id/recording", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    // A coordinator: their clients' calls too (viewWhere).
    const call = await prisma.callLog.findFirst({ where: { id, ...(await viewWhere(req)) } });
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
