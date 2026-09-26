// Slows down password guessing against the login endpoints (web and app).
// After MAX_FAILURES wrong passwords for the same username from the same
// address within WINDOW_MS, further attempts get 429 until the window
// passes. In memory — fine for one server process; it resets on restart,
// which is acceptable for this purpose.
const MAX_FAILURES = 8;
const WINDOW_MS = 15 * 60 * 1000;

const failures = new Map(); // key -> { count, first }

function keyFor(req, username) {
  return `${String(username).toLowerCase()}|${req.ip}`;
}

function isBlocked(req, username) {
  const entry = failures.get(keyFor(req, username));
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    failures.delete(keyFor(req, username));
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(req, username) {
  const key = keyFor(req, username);
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.first > WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
  else entry.count += 1;

  // Keep the map from growing without bound under a spray of usernames.
  if (failures.size > 10000) {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [k, v] of failures) if (v.first < cutoff) failures.delete(k);
  }
}

function recordSuccess(req, username) {
  failures.delete(keyFor(req, username));
}

module.exports = { isBlocked, recordFailure, recordSuccess };
