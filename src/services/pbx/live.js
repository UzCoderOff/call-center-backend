const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const prisma = require("../../lib/prisma");
const env = require("../../config/env");
const state = require("./state");
const { phoneKey } = require("../../lib/phone");
const { clientIndexFor } = require("../../lib/clientAccess");
const { ffmpegPath } = require("../../utils/audioTranscode");

// Client calls going on right now on Ledger's line, and listening to one live
// (the user's ask, 2026-10-24). Only for the developer, and for boss or lawyer
// accounts whose "listens to calls" switch the developer turned on
// (User.hearsCalls).
//
// What's going on comes from Asterisk (CoreShowChannels) when someone looks.
// The sound is the call's own recording as Asterisk writes it (MixMonitor,
// both sides), sent on as MP3 — nothing is added to the call, nobody on it
// can tell, and only recorded calls (clients, never colleagues) can be heard.

const LISTEN_TTL_MS = 2 * 60 * 1000;
const POLL_MS = 250;
const START_BACK_BYTES = 8000 * 2; // start ~1 s back (8 kHz, 16-bit)
const IDLE_END_MS = 2 * 60 * 1000; // no sound for this long: the stream ends
const MAX_MS = 3 * 60 * 60 * 1000;
const WAV_HEADER = 44;

function canHearCalls(user) {
  return Boolean(user && user.active !== false && (user.role === "DEVELOPER" || user.hearsCalls === true));
}

// "00:01:05" -> 65.
function seconds(duration) {
  const parts = String(duration || "").split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((sum, n) => sum * 60 + n, 0);
}

const STAFF = /^PJSIP\/([2-8]\d\d)-/;

// Pure: Asterisk's channels -> the client calls going on, longest first:
// [{ id (the call's Linkedid), direction "in" | "out", number, state
// "waiting" | "ringing" | "talking", seconds, exts [{ ext, state }],
// recordings [names to try] }]. Calls between colleagues aren't client calls.
function liveCalls(channels) {
  const groups = new Map();
  for (const c of channels) {
    if (!c.Linkedid) continue;
    if (!groups.has(c.Linkedid)) groups.set(c.Linkedid, []);
    groups.get(c.Linkedid).push(c);
  }
  const out = [];
  for (const [id, list] of groups) {
    // The client's side: in line or being put through ([company-line],
    // [ledger-transfer]); or a call out ([outbound]).
    const inbound = list.find((c) => ["company-line", "ledger-transfer"].includes(c.Context) && ["Queue", "Dial"].includes(c.Application));
    const outbound = inbound ? null : list.find((c) => c.Context === "outbound" && c.Application === "Dial");
    const client = inbound || outbound;
    if (!client) continue;
    const exts = new Map();
    for (const c of list) {
      const m = STAFF.exec(c.Channel || "");
      if (!m) continue;
      const up = c.ChannelState === "6" && Boolean(c.BridgeId);
      if (!exts.has(m[1]) || up) exts.set(m[1], up ? "talking" : "ringing");
    }
    let callState;
    if (inbound) {
      const states = [...exts.values()];
      callState = states.includes("talking") ? "talking" : states.includes("ringing") ? "ringing" : "waiting";
    } else {
      // The outside line answered: someone picked up.
      const far = list.find((c) => !STAFF.test(c.Channel || "") && !String(c.Channel).startsWith("Local/") && c.ChannelState === "6" && c.BridgeId);
      callState = far ? "talking" : "ringing";
      for (const ext of exts.keys()) exts.set(ext, callState);
    }
    const number = inbound ? inbound.CallerIDNum || "" : /^\d{9}$/.test(outbound.Exten || "") ? `+998${outbound.Exten}` : outbound.Exten || "";
    out.push({
      id,
      direction: inbound ? "in" : "out",
      number,
      state: callState,
      // The client's side has been on since the call began.
      seconds: seconds(client.Duration),
      exts: [...exts].map(([ext, s]) => ({ ext, state: s })).sort((a, b) => (a.state === "talking" ? -1 : 0) - (b.state === "talking" ? -1 : 0)),
      recordings: [...new Set([id, client.Uniqueid].filter(Boolean))],
    });
  }
  return out.sort((a, b) => b.seconds - a.seconds);
}

const safeName = (name) => /^[\w.-]{1,64}$/.test(name);

// The recording being written for a call, or null.
function recordingOf(call) {
  for (const name of call.recordings) {
    if (!safeName(name)) continue;
    const file = path.join(env.pbx.monitorDir, `${name}.wav`);
    if (fs.existsSync(file)) return `${name}.wav`;
  }
  return null;
}

async function channels() {
  if (!state.enabled || !state.ami?.ready) return [];
  return (await state.ami.actionList({ Action: "CoreShowChannels" })).filter((e) => e.Event === "CoreShowChannel");
}

// What the portal shows: the calls with who's on them and, as far as this
// person may see, which client.
async function snapshot(user) {
  const calls = liveCalls(await channels());
  if (!calls.length) return [];
  const exts = await prisma.pbxExtension.findMany({ where: { ext: { in: calls.flatMap((c) => c.exts.map((e) => e.ext)) } }, select: { ext: true, employee: { select: { name: true } } } });
  const names = new Map(exts.map((e) => [e.ext, e.employee.name]));
  const clients = await clientIndexFor(user, calls.map((c) => phoneKey(c.number)));
  return calls.map((c) => {
    const found = clients.get(phoneKey(c.number));
    return {
      id: c.id,
      direction: c.direction,
      number: c.number,
      client: found && !found.restricted ? { id: found.id, name: found.name } : null,
      state: c.state,
      seconds: c.seconds,
      people: c.exts.map((e) => ({ ext: e.ext, name: names.get(e.ext) || e.ext, state: e.state })),
      canListen: c.state === "talking" && Boolean(recordingOf(c)),
    };
  });
}

// ------------------------------------------------------------ listening

const sign = (payload) => crypto.createHmac("sha256", env.jwtSecret).update(payload).digest("base64url");

// A short-lived address to listen to call `id` — a plain <audio> can't send
// the login, so the address carries a signed, 2-minute token instead.
async function listenToken(user, id) {
  const call = liveCalls(await channels()).find((c) => c.id === id);
  if (!call || call.state !== "talking") return null;
  const file = recordingOf(call);
  if (!file) return null;
  const payload = Buffer.from(JSON.stringify({ u: user.id, f: file, e: Date.now() + LISTEN_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

// The token -> { userId, file } when it's genuine, fresh and its person may
// still listen; null otherwise.
async function checkToken(token) {
  const [payload, mac] = String(token || "").split(".");
  if (!payload || !mac) return null;
  const expected = sign(payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!data || data.e < Date.now() || !/^[\w.-]{1,64}\.wav$/.test(data.f || "")) return null;
  const user = await prisma.user.findUnique({ where: { id: Number(data.u) || -1 } });
  if (!canHearCalls(user)) return null;
  return { userId: user.id, file: path.join(env.pbx.monitorDir, data.f) };
}

// Streams the recording as it grows, as MP3, until the call ends (the file
// is taken in and removed), nothing new comes for a while, or the listener
// leaves.
function stream(file, req, res) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    res.status(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "Cross-Origin-Resource-Policy": "cross-origin" });
  const ff = spawn(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "8000", "-ac", "1", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-b:a", "32k", "-f", "mp3", "pipe:1"]);
  ff.stdout.pipe(res);
  ff.stdin.on("error", () => {});
  let pos = Math.max(WAV_HEADER, size - START_BACK_BYTES);
  pos -= (pos - WAV_HEADER) % 2;
  const started = Date.now();
  let lastSound = Date.now();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    ff.stdin.end();
    setTimeout(() => ff.kill("SIGKILL"), 3000).unref();
  };
  const timer = setInterval(() => {
    let now;
    try {
      now = fs.statSync(file).size;
    } catch {
      return finish(); // taken in: the call is over
    }
    if (now > pos) {
      const length = (now - pos) - ((now - pos) % 2);
      if (length > 0) {
        const buf = Buffer.alloc(length);
        const fd = fs.openSync(file, "r");
        try {
          fs.readSync(fd, buf, 0, length, pos);
        } finally {
          fs.closeSync(fd);
        }
        pos += length;
        lastSound = Date.now();
        ff.stdin.write(buf);
      }
    }
    if (Date.now() - lastSound > IDLE_END_MS || Date.now() - started > MAX_MS) finish();
  }, POLL_MS);
  req.on("close", () => {
    finish();
    ff.kill("SIGKILL");
  });
  ff.on("close", () => {
    clearInterval(timer);
    res.end();
  });
}

module.exports = { canHearCalls, liveCalls, snapshot, listenToken, checkToken, stream, seconds };
