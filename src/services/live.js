// "Something changed for you" without polling: each person has a version
// number that goes up when something of theirs changes (a chat message for
// them, a chat they read on another screen…); the portal asks
// GET /api/live?v=<last> and the answer waits until their version moves
// past it — or 20 s, then it asks again. So a message shows up on every
// open screen within a moment (src/routes/live.js; portal hooks/useLive).
//
// In memory: one server process. After a restart the versions start again
// from the clock, so every screen refreshes once.

const WAIT_MS = 20 * 1000;
const versions = new Map(); // userId -> number
const waiters = new Map(); // userId -> Set<resolve>
const start = Date.now();

const versionOf = (userId) => versions.get(userId) ?? start;

// These people have something new.
function bump(userIds) {
  for (const id of new Set(userIds)) {
    if (id == null) continue;
    const next = Math.max(Date.now(), versionOf(id) + 1);
    versions.set(id, next);
    const waiting = waiters.get(id);
    if (waiting) {
      waiters.delete(id);
      for (const resolve of waiting) resolve(next);
    }
  }
}

// Resolves with their version: at once when it's past `since`, else when
// it moves (or after WAIT_MS). `signal` (aborted when the request goes
// away) stops the wait early.
function waitFor(userId, since, { signal, ms = WAIT_MS } = {}) {
  const now = versionOf(userId);
  if (!Number.isFinite(since) || now > since) return Promise.resolve(now);
  return new Promise((resolve) => {
    const set = waiters.get(userId) || new Set();
    waiters.set(userId, set);
    const done = (value) => {
      clearTimeout(timer);
      set.delete(done);
      if (set.size === 0 && waiters.get(userId) === set) waiters.delete(userId);
      resolve(value);
    };
    const timer = setTimeout(() => done(versionOf(userId)), ms);
    set.add(done);
    signal?.addEventListener("abort", () => done(versionOf(userId)), { once: true });
  });
}

module.exports = { bump, waitFor, versionOf, WAIT_MS };
