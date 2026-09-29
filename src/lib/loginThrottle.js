const crypto = require("crypto");
const env = require("../config/env");

// Slows down password guessing against the login endpoints (web and app)
// without letting a stranger lock the real person out.
//
// The old rule counted wrong passwords per username (the server sits behind
// proxies, so every request looked like it came from the same address):
// anyone could type the boss's username wrong 8 times every 15 minutes and
// keep the boss out for good.
//
// Now there are two kinds of attempts:
//   - from a browser or phone that has signed in to this account before. It
//     carries a signed "known device" cookie for this account (one cookie per
//     account, signed with the server's secret together with the username,
//     so it can't be made up or reused for another account). It has its own
//     allowance and strangers' failures never block it;
//   - from anywhere else. These share one allowance per username; once it's
//     used up, unknown devices get 429 for the rest of the window — the
//     person still signs in from their usual phone or computer.
//
// Counts are in memory (they reset on restart); the cookies aren't.
const MAX_FAILURES = 8;
const WINDOW_MS = 15 * 60 * 1000;
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_USERNAME = 100;

const failures = new Map(); // key -> { count, first }

const norm = (username) => String(username).toLowerCase().slice(0, MAX_USERNAME);
const hmac = (value) => crypto.createHmac("sha256", `${env.jwtSecret}:known-device`).update(value).digest("base64url");
const cookieName = (name) => `kd_${crypto.createHash("sha256").update(name).digest("hex").slice(0, 12)}`;

// This browser's device id for the account, if it has signed in to it before.
function knownDevice(req, name) {
  const raw = req.cookies?.[cookieName(name)];
  if (typeof raw !== "string") return null;
  const [id, mac] = raw.split(".");
  if (!id || !mac || id.length > 40) return null;
  const expected = hmac(`${id}|${name}`);
  if (expected.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
  return id;
}

function keyFor(req, username) {
  const name = norm(username);
  const id = knownDevice(req, name);
  return id ? `${name}|device:${id}` : `${name}|anyone`;
}

function entryFor(key) {
  const entry = failures.get(key);
  if (entry && Date.now() - entry.first > WINDOW_MS) {
    failures.delete(key);
    return null;
  }
  return entry || null;
}

function isBlocked(req, username) {
  return (entryFor(keyFor(req, username))?.count || 0) >= MAX_FAILURES;
}

function recordFailure(req, username) {
  const key = keyFor(req, username);
  const entry = entryFor(key);
  if (!entry) failures.set(key, { count: 1, first: Date.now() });
  else entry.count += 1;
  // Keep the map from growing without bound under a spray of usernames.
  if (failures.size > 10000) {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [k, v] of failures) if (v.first < cutoff) failures.delete(k);
  }
}

// A successful sign-in: this browser/phone becomes a known device for the
// account (a long-lived signed cookie, sent only to the API).
function recordSuccess(req, res, username) {
  const name = norm(username);
  const id = knownDevice(req, name);
  if (id) {
    failures.delete(`${name}|device:${id}`);
    return;
  }
  const fresh = crypto.randomBytes(12).toString("base64url");
  res?.cookie?.(cookieName(name), `${fresh}.${hmac(`${fresh}|${name}`)}`, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: env.cookieSameSite,
    maxAge: COOKIE_MAX_AGE_MS,
    path: "/api",
  });
}

module.exports = { isBlocked, recordFailure, recordSuccess, MAX_FAILURES, MAX_USERNAME };
