const fs = require("fs");
const path = require("path");
const prisma = require("../../lib/prisma");
const env = require("../../config/env");
const { phoneKey } = require("../../lib/phone");
const { events } = require("../../lib/events");
const { reconcileFollowUps } = require("../followUp");
const { transcodeToMp3, PHONE_LINE_AUDIO } = require("../../utils/audioTranscode");
const { hasJob } = require("../../lib/jobs");
const { normalizeUz } = require("./numbers");
const { pbxSettings, savePbxSettings } = require("./settings");
const presence = require("./presence");

// Calls on Ledger's phone line, into Ledger. When a call ends, the dialplan
// (pbx/asterisk/extensions.conf) leaves small files in PBX_SPOOL_DIR, one line
// of key=value&… each:
//
//   <call>.call.evt           the call: dir (in | out), num (the outside
//                             number), ext (out: who called), start, end
//                             (epoch seconds), status, talk (seconds), rec
//                             (the recording's file name in PBX_MONITOR_DIR)
//   <call>.ring-<ext>-<n>.evt each time a phone was rung for it: ext, rs
//                             (when), waited (seconds the phone took to come
//                             up), status (ANSWER, NOANSWER, WAKE_TIMEOUT…),
//                             talk, kind (queue | direct | internal)
//
// Files survive a backend restart (a deploy stops it for a minute); they're
// picked up here, a call becomes a CallLog row (source "pbx") just like one
// synced from a phone — same call-back list, Telegram, reports, strikes —
// and its recording becomes a small MP3 next to the phone recordings.

const SETTLE_MS = 3000; // a call's ring files may land just after it
const ORPHAN_RING_MS = 10 * 60 * 1000;
const MIN_RECORDING_BYTES = 44 + 16000; // WAV header + 1 s of 8 kHz audio

const parseEvt = (text) => Object.fromEntries(new URLSearchParams(String(text).trim()));

// The outside number as stored on a call: +998… when it's Uzbek, the digits
// otherwise, "" when hidden.
function storedNumber(raw) {
  const text = String(raw ?? "").trim();
  if (!/\d/.test(text) || /anonymous|unknown|restricted/i.test(text)) return "";
  const uz = normalizeUz(text);
  return uz.e164 || text.replace(/[^\d+]/g, "");
}

// Pure: a call's files -> what to store, or null when it belongs to nobody.
//   employeeByExt  Map<ext, employeeId> (everyone who has a phone ID)
//   pickRotation   () -> employeeId for a missed call nobody was rung for
function summarizeCall(call, rings, { employeeByExt, pickRotation }) {
  const start = Number(call.start) || 0;
  const phoneNumber = storedNumber(call.num);
  const base = { callTimestampMs: start * 1000, phoneNumber };

  if (call.dir === "out") {
    const employeeId = employeeByExt.get(call.ext) ?? null;
    if (!employeeId) return null;
    const answered = call.status === "ANSWER";
    return {
      ...base,
      employeeId,
      callType: "outgoing",
      missed: false,
      durationSeconds: answered ? Math.max(0, Number(call.talk) || 0) : 0,
      answered,
      detail: { owner: "caller", status: call.status || null },
    };
  }

  const rang = rings
    .slice()
    .sort((a, b) => (Number(a.rs) || 0) - (Number(b.rs) || 0))
    .map((r) => ({
      ext: r.ext,
      employeeId: employeeByExt.get(r.ext) ?? null,
      status: r.status || "",
      waitedSec: Number(r.waited) || 0,
      talkSec: Number(r.talk) || 0,
    }));
  const queueWaitSec = Math.max(0, (Number(call.end) || start) - start);
  const answer = rang.find((r) => r.status === "ANSWER" && r.employeeId);
  if (answer) {
    return {
      ...base,
      employeeId: answer.employeeId,
      callType: "incoming",
      missed: false,
      durationSeconds: answer.talkSec,
      answered: true,
      detail: { rang, owner: "answered", status: call.status || null },
    };
  }
  // Missed: the operator whose turn it was (rung first) owns it — their
  // call-back list, their Telegram, their strike — or, when nobody could be
  // rung at all, whoever's turn it is in the rotation.
  const first = rang.find((r) => r.employeeId);
  const employeeId = first ? first.employeeId : pickRotation();
  if (!employeeId) return null;
  return {
    ...base,
    employeeId,
    callType: "missed",
    missed: true,
    durationSeconds: 0,
    answered: false,
    detail: { rang, owner: first ? "first_rung" : "rotation", status: call.status || null, reason: rang.length ? "not_answered" : "nobody_free", queueWaitSec },
  };
}

// Whose turn it is to own a missed call nobody was rung for: active
// call-center staff on the line, in turn — or, with nobody on the line yet,
// any active call-center staff, so a client's call is never lost.
async function rotationPicker() {
  const callCenter = (await prisma.employee.findMany({ where: { active: true }, select: { id: true, job: true, extraJobs: true, pbxCalling: true }, orderBy: { id: "asc" } })).filter((e) =>
    hasJob(e, "call_center")
  );
  const onLine = callCenter.filter((e) => e.pbxCalling);
  const people = onLine.length ? onLine : callCenter;
  let next = (await pbxSettings()).rotation || 0;
  let saved = next;
  return {
    pick: () => (people.length ? people[next++ % people.length].id : null),
    save: async () => {
      if (next === saved) return;
      saved = next;
      await savePbxSettings({ rotation: next });
    },
  };
}

const callIdOf = (file) => file.replace(/\.call\.evt$/, "");
const safeId = (id) => /^[\w.-]{1,64}$/.test(id);

function readEvt(file) {
  return parseEvt(fs.readFileSync(path.join(env.pbx.spoolDir, file), "utf8"));
}

function removeQuietly(file) {
  fs.rm(file, { force: true }, () => {});
}

// Turns the recording into an MP3 next to the phone recordings; returns
// { recordingPath, recordingFilename } or {} when there's nothing to keep.
async function saveRecording(rec, { employeeId, callTimestampMs, callId, answered }) {
  if (!rec || !/^[\w.-]+\.wav$/.test(rec)) return {};
  const wav = path.join(env.pbx.monitorDir, rec);
  let size = 0;
  try {
    size = fs.statSync(wav).size;
  } catch {
    return {};
  }
  if (!answered || size < MIN_RECORDING_BYTES) {
    removeQuietly(wav);
    return {};
  }
  const name = `${callTimestampMs}-pbx-${callId.replace(/[^\w-]/g, "_")}.mp3`;
  const relative = path.join(String(employeeId), name);
  await transcodeToMp3(wav, path.join(env.storageRoot, relative), PHONE_LINE_AUDIO);
  removeQuietly(wav);
  return { recordingPath: relative, recordingFilename: name };
}

async function processCall(callId, ringFiles, rotation) {
  const call = readEvt(`${callId}.call.evt`);
  const rings = ringFiles.map(readEvt);
  await presence.noteCallRings(rings);

  const exts = await prisma.pbxExtension.findMany({ select: { ext: true, employeeId: true } });
  const summary = summarizeCall(call, rings, { employeeByExt: new Map(exts.map((e) => [e.ext, e.employeeId])), pickRotation: rotation.pick });
  if (!summary) {
    console.warn(`[pbx] call ${callId} (${call.dir || "?"}, ${call.num || "no number"}) belongs to nobody — no call-center staff and no known phone ID; not kept`);
    if (/^[\w.-]+\.wav$/.test(call.rec || "")) removeQuietly(path.join(env.pbx.monitorDir, call.rec));
    return null;
  }

  const recording = await saveRecording(call.rec, { ...summary, callId });
  const key = phoneKey(summary.phoneNumber);
  const fields = {
    employeeId: summary.employeeId,
    phoneNumber: summary.phoneNumber,
    phoneKey: key,
    callType: summary.callType,
    missed: summary.missed,
    durationSeconds: summary.durationSeconds,
    callTimestampMs: BigInt(summary.callTimestampMs),
    syncedAtMs: BigInt(Date.now()),
    source: "pbx",
    pbxDetail: summary.detail,
    ...recording,
  };
  const row = await prisma.callLog.upsert({
    where: { pbxCallId: callId },
    create: { ...fields, pbxCallId: callId, deviceCallLogId: `pbx:${callId}`, followUp: summary.missed ? (key ? "pending" : "no_number") : null },
    update: fields,
    select: { id: true },
  });
  await rotation.save();
  if (key) {
    try {
      await reconcileFollowUps([key]);
    } catch (err) {
      console.error("[pbx] follow-up reconciliation failed:", err.message);
    }
  }
  events.emit("calls.synced", { employeeId: summary.employeeId, callIds: [row.id], recordingCallIds: recording.recordingPath ? [row.id] : [] });
  return row.id;
}

let sweeping = null;
function sweep() {
  if (!sweeping) sweeping = doSweep().finally(() => (sweeping = null));
  return sweeping;
}

async function doSweep(now = Date.now()) {
  const dir = env.pbx.spoolDir;
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".evt"));
  } catch {
    return;
  }
  const age = (f) => {
    try {
      return now - fs.statSync(path.join(dir, f)).mtimeMs;
    } catch {
      return -1;
    }
  };
  const ringsOf = (id) => files.filter((f) => f.startsWith(`${id}.ring-`));
  const rotation = await rotationPicker();

  for (const file of files.filter((f) => f.endsWith(".call.evt"))) {
    const id = callIdOf(file);
    if (!safeId(id) || age(file) < SETTLE_MS) continue;
    const rings = ringsOf(id);
    try {
      await processCall(id, rings, rotation);
      for (const f of [file, ...rings]) removeQuietly(path.join(dir, f));
    } catch (err) {
      // The database or ffmpeg failing: the files stay and are tried again.
      console.error(`[pbx] call ${id} not taken in yet: ${err.message}`);
    }
  }

  // Rings without a call: staff calling each other (not kept as calls), or
  // a call file that never came. They still tell whether the phone works.
  const callIds = new Set(files.filter((f) => f.endsWith(".call.evt")).map(callIdOf));
  for (const file of files.filter((f) => f.includes(".ring-"))) {
    const id = file.slice(0, file.indexOf(".ring-"));
    let ring;
    try {
      ring = readEvt(file);
    } catch {
      continue;
    }
    const internal = ring.kind === "internal";
    if (callIds.has(id) && !internal) continue;
    if (age(file) < (internal ? SETTLE_MS : ORPHAN_RING_MS)) continue;
    try {
      if (ring.ext && ring.status) await presence.noteRing(ring.ext, ring.status);
      removeQuietly(path.join(dir, file));
    } catch (err) {
      console.error(`[pbx] ring ${file}: ${err.message}`);
    }
  }
}

function start() {
  const dir = env.pbx.spoolDir;
  let timer = null;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => sweep().catch((err) => console.error("[pbx] sweep failed:", err.message)), SETTLE_MS + 500);
  };
  try {
    fs.watch(dir, soon);
  } catch (err) {
    console.warn(`[pbx] can't watch ${dir}: ${err.message} (checking every 15 s instead)`);
  }
  setInterval(soon, 15 * 1000).unref();
  soon();
}

module.exports = { parseEvt, storedNumber, summarizeCall, processCall, sweep, start };
