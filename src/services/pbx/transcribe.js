const fs = require("fs");
const path = require("path");
const prisma = require("../../lib/prisma");
const env = require("../../config/env");
const state = require("./state");

// Calls turned into text on this server (the user's ask, 2026-10-24): the
// firm's own Uzbek speech model runs in pbx/transcriber (Python), only when
// the server is free — at idle priority, and paused while anyone is on a
// call. It asks Ledger for work and hands the text back through the hooks
// listener (hooks.js, 127.0.0.1 only, with the hook secret):
//
//   POST /pbx/busy                 -> "0" | "1": a call is going on (wait)
//   POST /pbx/transcribe/next      -> { id, files: [{ who, path }] } | {}
//   POST /pbx/transcribe/done      { id, language, segments: [{ who, start, end, text }] }
//   POST /pbx/transcribe/failed    { id, error }
//
// Each side of a call is recorded on its own (extensions.conf MixMonitor
// r()/t(): <call>.client.wav, <call>.staff.wav), so the text says who said
// what. Ingest (ingest.js) queues the calls worth reviewing (callReview.js
// reviewable): their side files move to STORAGE_ROOT/transcribe/<callLogId>.*.wav
// and wait there; they're deleted once the text is in.

const DIR = () => path.join(env.storageRoot, "transcribe");
const SIDES = ["client", "staff"];
const STUCK_MS = 60 * 60 * 1000;
// A call the transcriber got stuck on — it went past its time or memory limit,
// or died on it and never answered — gets one more try, then it's given up on.
// A "poison" call used to come back every hour for ever (2026-10-28: a
// 14-second call took the transcriber to 3 GB and froze the server). The mark
// rides in errorMessage until the text is in.
const STUCK_ONCE = "stuck once, trying again";
const GAVE_UP = "stuck twice, given up";

// A side as Asterisk wrote it: 16 kHz (.wav16, since HD voice) or, from
// before, 8 kHz (.wav). Either is a plain WAV file.
function sideFile(callId, who) {
  const hd = path.join(env.pbx.monitorDir, `${callId}.${who}.wav16`);
  return fs.existsSync(hd) ? hd : path.join(env.pbx.monitorDir, `${callId}.${who}.wav`);
}
const queuedFile = (callLogId, who) => path.join(DIR(), `${callLogId}.${who}.wav`);

// After a call is taken in: queue it (the side files move along) — or, when
// it isn't worth reviewing, just drop its side files.
async function queueOrDrop(callId, row, { review }) {
  const present = SIDES.filter((who) => fs.existsSync(sideFile(callId, who)));
  if (!review) {
    for (const who of present) fs.rmSync(sideFile(callId, who), { force: true });
    return false;
  }
  fs.mkdirSync(DIR(), { recursive: true });
  for (const who of present) {
    try {
      fs.renameSync(sideFile(callId, who), queuedFile(row.id, who));
    } catch (err) {
      if (err.code !== "EXDEV") throw err;
      // Another disk: copy, then remove.
      fs.copyFileSync(sideFile(callId, who), queuedFile(row.id, who));
      fs.rmSync(sideFile(callId, who), { force: true });
    }
  }
  await prisma.transcript.upsert({
    where: { callLogId: row.id },
    create: { callLogId: row.id, status: "pending", provider: "uz-asr" },
    update: { status: "pending", errorMessage: null },
  });
  return true;
}

// A message a caller left ([line-message] in extensions.conf): its WAV moves
// to the queue as the client's side. Only text — a message has no operator
// to review (reviewCall skips missed calls).
async function queueMessage(row, wav) {
  fs.mkdirSync(DIR(), { recursive: true });
  try {
    fs.renameSync(wav, queuedFile(row.id, "client"));
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    fs.copyFileSync(wav, queuedFile(row.id, "client"));
    fs.rmSync(wav, { force: true });
  }
  await prisma.transcript.upsert({
    where: { callLogId: row.id },
    create: { callLogId: row.id, status: "pending", provider: "uz-asr" },
    update: { status: "pending", errorMessage: null },
  });
}

// The audio for a queued call: its two sides, or — recorded before the sides
// were kept apart — the call's MP3.
async function filesFor(callLogId) {
  const sides = SIDES.filter((who) => fs.existsSync(queuedFile(callLogId, who))).map((who) => ({ who, path: queuedFile(callLogId, who) }));
  if (sides.length) return sides;
  const call = await prisma.callLog.findUnique({ where: { id: callLogId }, select: { recordingPath: true } });
  if (!call?.recordingPath) return [];
  const mix = path.join(env.storageRoot, call.recordingPath);
  return fs.existsSync(mix) ? [{ who: "mix", path: mix }] : [];
}

// The next call to turn into text (newest first, so today's calls come
// back soonest). Work stuck "processing" for an hour goes back in the queue —
// once: stuck a second time, it's given up on.
async function next() {
  const stuck = { status: "processing", updatedAt: { lt: new Date(Date.now() - STUCK_MS) } };
  const why = "the transcriber never answered";
  await prisma.transcript.updateMany({ where: { ...stuck, errorMessage: { startsWith: STUCK_ONCE } }, data: { status: "failed", errorMessage: `${GAVE_UP}: ${why}` } });
  await prisma.transcript.updateMany({ where: stuck, data: { status: "pending", errorMessage: `${STUCK_ONCE}: ${why}` } });
  for (let tries = 0; tries < 5; tries++) {
    const job = await prisma.transcript.findFirst({ where: { status: "pending" }, orderBy: { createdAt: "desc" }, select: { callLogId: true } });
    if (!job) return {};
    const files = await filesFor(job.callLogId);
    if (!files.length) {
      await prisma.transcript.update({ where: { callLogId: job.callLogId }, data: { status: "failed", errorMessage: "no audio" } });
      continue;
    }
    await prisma.transcript.update({ where: { callLogId: job.callLogId }, data: { status: "processing" } });
    return { id: job.callLogId, files };
  }
  return {};
}

// The proper Uzbek letters: models write oʻ / gʻ and the tutuq belgisi with a
// plain apostrophe (o'tdi, ma'lum) — Ledger writes oʻ, gʻ and ʼ.
function uzLetters(text) {
  return text
    // "Xo 'p", "bo 'ldi", "qoʻymadingiz -a": pieces of one word split apart
    .replace(/([OoGg]) ['‘’`ʼ](?=[a-z])/g, "$1ʻ")
    .replace(/([a-zʻ]) -(a|da|chi|mi|u|yu|ku|ki)(?![a-zʻ])/g, "$1-$2")
    .replace(/([OoGg])['‘’`ʼ]/g, "$1ʻ")
    .replace(/([A-Za-zʻ])['’`](?=[A-Za-z])/g, "$1ʼ");
}

const cleanSegments = (list) =>
  (Array.isArray(list) ? list : [])
    .map((s) => ({ who: ["client", "staff", "mix"].includes(s?.who) ? s.who : "mix", start: Number(s?.start) || 0, end: Number(s?.end) || 0, text: uzLetters(String(s?.text || "").trim()).slice(0, 2000) }))
    .filter((s) => s.text)
    .sort((a, b) => a.start - b.start)
    .slice(0, 2000);

// The text is in: kept (segments + plain text), the audio dropped, and the
// AI review started.
async function done({ id, language, segments }) {
  const callLogId = Number(id);
  const clean = cleanSegments(segments);
  const { transcriptText } = require("../callReview");
  await prisma.transcript.update({
    where: { callLogId },
    data: { status: "done", segments: clean, text: transcriptText(clean), language: String(language || "uz").slice(0, 8), errorMessage: null },
  });
  for (const who of SIDES) fs.rmSync(queuedFile(callLogId, who), { force: true });
  console.log(`[pbx] call ${callLogId} turned into text (${clean.length} lines)`);
  require("../callReview")
    .reviewCall(callLogId)
    .catch((err) => console.error(`[call-review] call ${callLogId}:`, err.message));
  return "ok";
}

// The transcriber couldn't do a call. "stuck": it went past the call's time or
// memory limit — one more try, like a call stuck "processing".
async function failed({ id, error, stuck }) {
  const callLogId = Number(id);
  let why = String(error || "failed").slice(0, 250);
  if (stuck) {
    const row = await prisma.transcript.findUnique({ where: { callLogId }, select: { errorMessage: true } });
    if (!row?.errorMessage?.startsWith(STUCK_ONCE)) {
      await prisma.transcript.update({ where: { callLogId }, data: { status: "pending", errorMessage: `${STUCK_ONCE}: ${why}` } });
      return "ok";
    }
    why = `${GAVE_UP}: ${why}`;
  }
  await prisma.transcript.update({ where: { callLogId }, data: { status: "failed", errorMessage: why } });
  return "ok";
}

// Anyone on a call right now (the transcriber waits): "1" or "0".
let busyCache = { at: 0, value: "0" };
async function busy() {
  if (Date.now() - busyCache.at < 800) return busyCache.value;
  let value = "0";
  if (state.enabled && state.ami?.ready) {
    try {
      const channels = await state.ami.actionList({ Action: "CoreShowChannels" });
      value = channels.some((e) => e.Event === "CoreShowChannel") ? "1" : "0";
    } catch {
      value = "1"; // can't tell: better wait
    }
  }
  busyCache = { at: Date.now(), value };
  return value;
}

module.exports = { queueOrDrop, queueMessage, next, done, failed, busy, cleanSegments, uzLetters, filesFor, DIR };
