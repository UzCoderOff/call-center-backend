const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawnSync } = require("child_process");
const env = require("../config/env");

// Every extension the browser's own <audio> element can decode natively,
// mapped to the Content-Type that actually makes that true. Anything
// outside this map gets transcoded to MP3 instead (see isWebSafeExtension
// below) — WEB_SAFE_EXTENSIONS is derived FROM this map's keys rather than
// listed separately, on purpose: routes/calls.js used to keep its own,
// hand-copied extension->mimetype table, and that second copy quietly
// fell out of sync (missing ".mp4" and ".ogg"), so a real, natively
// playable recording in either format got served with
// "Content-Type: application/octet-stream" — which browsers refuse to
// play in an <audio> tag. It looked exactly like the AMR bug this file was
// written to fix. Keeping a single source of truth here, imported by
// calls.js, makes that class of bug impossible to reintroduce.
const WEB_SAFE_MIME_TYPES = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
};
const WEB_SAFE_EXTENSIONS = new Set(Object.keys(WEB_SAFE_MIME_TYPES));

// Cached transcodes live next to (not inside) the real recordings, mirroring
// the same <employeeId>/<file> layout, so nothing that walks the recordings
// folder itself needs to know this cache exists.
const CACHE_ROOT = path.join(path.dirname(env.storageRoot), "recording-cache");
fs.mkdirSync(CACHE_ROOT, { recursive: true });

function isWebSafeExtension(ext) {
  return WEB_SAFE_EXTENSIONS.has(ext.toLowerCase());
}

function cachePathFor(relativeRecordingPath) {
  const parsed = path.parse(relativeRecordingPath);
  return path.join(CACHE_ROOT, parsed.dir, `${parsed.name}.mp3`);
}

// --- ffmpeg binary resolution -------------------------------------------
//
// ffmpeg-static ships no ffmpeg of its own — its postinstall script
// downloads a real prebuilt binary from GitHub the moment `npm install`
// runs. That download needs outbound internet access AT INSTALL TIME. On
// a server with restricted/no egress (firewalled internal box, offline
// deploy, an air-gapped VM — exactly the kind of place a law firm's
// in-house call-recording tool tends to live) that download can fail
// silently: npm still finishes, `require("ffmpeg-static")` still resolves
// to a path string either way, but nothing is actually there. The old
// code only checked "is the package installed", never "does the binary
// file actually exist" — so this exact failure mode looked identical to
// success until the first real playback attempt, and even then just
// surfaced as a generic ffmpeg error.
//
// This resolves once per process, prefers the ffmpeg-static binary when
// it's genuinely present on disk, and otherwise falls back to whatever
// "ffmpeg" resolves to on $PATH (e.g. `apt install ffmpeg` /
// `brew install ffmpeg` done directly on the host) before giving up.
let ffmpegCommand = null;
let ffmpegSource = null; // "ffmpeg-static" | "path-fallback"
let resolved = false;

function resolveFfmpeg() {
  if (resolved) return;
  resolved = true;

  let staticPath = null;
  try {
    staticPath = require("ffmpeg-static");
  } catch {
    staticPath = null;
  }

  if (staticPath && fs.existsSync(staticPath)) {
    ffmpegCommand = staticPath;
    ffmpegSource = "ffmpeg-static";
    return;
  }

  // Either the package isn't installed at all, or it is but its binary
  // never got downloaded. Either way, fall back to a system "ffmpeg" —
  // execFile/spawnSync will surface a clear ENOENT if there isn't one.
  ffmpegCommand = "ffmpeg";
  ffmpegSource = "path-fallback";
}

// Called once at server startup (see server.js) so a missing/broken
// ffmpeg is a loud, immediate warning in the server logs — not something
// that only surfaces when someone in the field tries to play back their
// first AMR recording and it just fails.
function describeFfmpegAvailability() {
  resolveFfmpeg();

  if (ffmpegSource === "ffmpeg-static") {
    return { ok: true, message: `Recording playback: using the bundled ffmpeg-static binary (${ffmpegCommand}).` };
  }

  const probe = spawnSync(ffmpegCommand, ["-version"]);
  if (probe.error || probe.status !== 0) {
    return {
      ok: false,
      message:
        "Recording playback: no working ffmpeg found. AMR (and any other non-browser-safe) recordings will fail " +
        "to play until this is fixed. Run `npm install` in call-center-backend (ffmpeg-static's postinstall " +
        "needs outbound internet access to download its binary) — or, if this server has no internet access, " +
        "install ffmpeg on the host directly (e.g. `apt install ffmpeg`); it will be picked up automatically.",
    };
  }
  return {
    ok: true,
    message: 'Recording playback: ffmpeg-static\'s binary isn\'t available — using a system "ffmpeg" found on PATH instead.',
  };
}

// Two requests for the same not-yet-cached recording (e.g. a list view
// pre-loading a player plus the detail page open in another tab, or just
// a fast double-click) would otherwise both call ffmpeg for the same
// destination file at once, racing to write/rename the same temp file. A
// second concurrent request for the same destination just waits on the
// first one's in-flight promise instead of starting its own ffmpeg
// process and stepping on it.
const inFlightTranscodes = new Map(); // destAbsolutePath -> Promise

// Runs ffmpeg to produce an MP3 at destAbsolutePath. Writes to a
// uniquely-named temp file first and renames on success, so a request
// that arrives mid-conversion (or a crash partway through, or a second
// server process doing the same thing) never sees/serves a truncated
// cache file, and two writers can never corrupt each other's temp file.
function transcodeToMp3(sourceAbsolutePath, destAbsolutePath) {
  resolveFfmpeg();

  const tmpPath = path.join(
    path.dirname(destAbsolutePath),
    `.${path.basename(destAbsolutePath)}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.part`
  );

  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destAbsolutePath), { recursive: true });

    // Recordings are phone-call speech, not music — mono, 44.1kHz, 64kbps
    // is plenty and keeps the cache small.
    //
    // "-f mp3" forces the output muxer explicitly. Without it, ffmpeg
    // infers the output format from the destination filename's extension
    // — and since we write to a temp path first and rename on success
    // (tmpPath ends in ".part", not ".mp3"), ffmpeg can't tell what
    // format to write and fails immediately with "Unable to choose an
    // output format" for every single conversion. This was the actual
    // reason AMR recordings never played even with everything else
    // (routing, caching, content-type) wired correctly.
    execFile(
      ffmpegCommand,
      ["-y", "-i", sourceAbsolutePath, "-vn", "-ac", "1", "-ar", "44100", "-b:a", "64k", "-f", "mp3", tmpPath],
      (err, _stdout, stderr) => {
        if (err) {
          fs.unlink(tmpPath, () => {});
          const hint =
            err.code === "ENOENT"
              ? ` (no working ffmpeg binary found at "${ffmpegCommand}" — run \`npm install\` in call-center-backend, or install ffmpeg on this server)`
              : "";
          reject(new Error(`ffmpeg failed: ${stderr || err.message}${hint}`));
          return;
        }
        fs.rename(tmpPath, destAbsolutePath, (renameErr) => {
          if (renameErr) reject(renameErr);
          else resolve();
        });
      }
    );
  });
}

function transcodeToMp3Deduped(sourceAbsolutePath, destAbsolutePath) {
  const existing = inFlightTranscodes.get(destAbsolutePath);
  if (existing) return existing;

  const promise = transcodeToMp3(sourceAbsolutePath, destAbsolutePath).finally(() => {
    inFlightTranscodes.delete(destAbsolutePath);
  });
  inFlightTranscodes.set(destAbsolutePath, promise);
  return promise;
}

// Given a call's stored relative recording path and the function that turns
// it into an absolute path (fileStorage.resolveRecordingPath), returns the
// absolute path + Content-Type that should actually be sent to the browser:
// the original file untouched when its format is already web-playable,
// otherwise a cached MP3 transcode (generated once, reused after that).
async function resolvePlayableRecording(relativeRecordingPath, resolveOriginalPath) {
  const ext = path.extname(relativeRecordingPath).toLowerCase();
  const originalAbsolutePath = resolveOriginalPath(relativeRecordingPath);

  if (isWebSafeExtension(ext)) {
    return { absolutePath: originalAbsolutePath, contentType: WEB_SAFE_MIME_TYPES[ext] };
  }

  const cachedAbsolutePath = cachePathFor(relativeRecordingPath);
  if (!fs.existsSync(cachedAbsolutePath)) {
    await transcodeToMp3Deduped(originalAbsolutePath, cachedAbsolutePath);
  }
  return { absolutePath: cachedAbsolutePath, contentType: "audio/mpeg" };
}

module.exports = {
  resolvePlayableRecording,
  isWebSafeExtension,
  WEB_SAFE_EXTENSIONS,
  WEB_SAFE_MIME_TYPES,
  describeFfmpegAvailability,
};
