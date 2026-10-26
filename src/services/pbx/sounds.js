const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const env = require("../../config/env");
const { ffmpegPath } = require("../../utils/audioTranscode");

// The firm's own voice on the line (the user's ask, 2026-10-26: a staff
// member records them, no AI voice). Each one is uploaded in Settings →
// Phone line and kept in PBX_SOUNDS_DIR, where Asterisk plays it
// (extensions.conf, queues.conf):
//   greeting         every call in working hours, before anyone is rung
//   coordinator      instead, for a client with a contract: they're put
//                    through to their coordinator
//   coordinatorBusy  their coordinator didn't answer: the call center is rung
//   waiting          every 40 s while the caller waits in line (queues.conf)
//   busy             nobody could take the call: then the caller leaves a message
//   night            outside working hours: then the caller leaves a message
//   thanks           after their message
// One recording becomes <key>.wav (8 kHz, what the outside line carries),
// <key>.wav16 (16 kHz, for HD staff phones) and <key>.mp3 (to listen to in
// the portal). A message that isn't there is skipped — except the night
// one, without which the line stays as in the daytime (provision.js).
const KEYS = ["greeting", "coordinator", "coordinatorBusy", "waiting", "busy", "night", "thanks"];
const MAX_SECONDS = 60;

const dir = () => env.pbx.soundsDir;
const fileOf = (key, ext) => path.join(dir(), `${key}.${ext}`);
const isKey = (key) => KEYS.includes(key);

// Which messages are there: { greeting: { at, seconds }, … } — seconds from
// the 8 kHz file (16-bit mono, 16 000 bytes a second after the header).
function present() {
  const out = {};
  for (const key of KEYS) {
    try {
      const stat = fs.statSync(fileOf(key, "wav"));
      out[key] = { at: stat.mtime, seconds: Math.round(Math.max(0, stat.size - 44) / 16000) };
    } catch {
      // not uploaded
    }
  }
  return out;
}

// Tidied for the phone: low rumble cut, the silence at both ends trimmed,
// the loudness evened out — at most a minute.
const CLEANUP = [
  "highpass=f=80",
  "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15",
  "areverse",
  "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.3",
  "areverse",
  "loudnorm=I=-17:TP=-2:LRA=11",
].join(",");

// Plain WAV for Asterisk: no tags chunk before the sound (-bitexact, no
// metadata), so the header is the usual 44 bytes.
const PLAIN = ["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact"];
const OUTPUTS = [
  { ext: "wav", args: ["-ar", "8000", "-c:a", "pcm_s16le", ...PLAIN, "-f", "wav"] },
  { ext: "wav16", args: ["-ar", "16000", "-c:a", "pcm_s16le", ...PLAIN, "-f", "wav"] },
  { ext: "mp3", args: ["-ar", "16000", "-b:a", "48k", "-f", "mp3"] },
];

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), args, { timeout: 60 * 1000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, _out, stderr) =>
      err ? reject(new Error(`ffmpeg failed: ${String(stderr || err.message).trim().slice(-300)}`)) : resolve()
    );
  });
}

// An uploaded recording (any format ffmpeg reads) -> the line's message
// `key`, replacing the old one. Throws "not_audio" when ffmpeg can't read it.
async function save(key, source) {
  if (!isKey(key)) throw new Error("unknown message");
  fs.mkdirSync(dir(), { recursive: true });
  const tag = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const parts = OUTPUTS.map((o) => ({ ...o, tmp: path.join(dir(), `.${key}.${tag}.${o.ext}.part`) }));
  try {
    for (const p of parts) {
      // -protocol_whitelist file: an upload can't make ffmpeg fetch anything.
      await run(["-nostdin", "-loglevel", "error", "-protocol_whitelist", "file", "-y", "-i", source, "-vn", "-t", String(MAX_SECONDS), "-af", CLEANUP, "-ac", "1", ...p.args, p.tmp]);
    }
  } catch (err) {
    for (const p of parts) fs.rmSync(p.tmp, { force: true });
    const e = new Error("not_audio");
    e.detail = err.message;
    throw e;
  }
  for (const p of parts) {
    fs.chmodSync(p.tmp, 0o640);
    fs.renameSync(p.tmp, fileOf(key, p.ext));
  }
  return present()[key] || null;
}

function remove(key) {
  if (!isKey(key)) return;
  for (const o of OUTPUTS) fs.rmSync(fileOf(key, o.ext), { force: true });
}

// The portal's copy to listen to, or null.
function listenFile(key) {
  if (!isKey(key)) return null;
  const file = fileOf(key, "mp3");
  return fs.existsSync(file) ? file : null;
}

module.exports = { KEYS, MAX_SECONDS, isKey, present, save, remove, listenFile, fileOf };
