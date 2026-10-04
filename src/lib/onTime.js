// Exactly on time: the clock jobs look once a minute (services/telegram/
// jobs.js), so anything due before the next look gets a timer of its own
// and goes out on the second. The minute check stays the safety net (a
// restart, a time moved): `run` must be safe to call any time.

const LOOK_AHEAD_MS = 75 * 1000;
const timers = new Map(); // key -> { at, timer }

// `run` at `when` (a Date) when that's before the next minute's look.
function onTime(key, when, run) {
  const at = when.getTime();
  const ms = at - Date.now();
  if (ms > LOOK_AHEAD_MS) return false;
  const existing = timers.get(key);
  if (existing && existing.at === at) return true;
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    timers.delete(key);
    Promise.resolve()
      .then(run)
      .catch((err) => console.error(`[on time] ${key}:`, err.message));
  }, Math.max(0, ms) + 250);
  timer.unref?.();
  timers.set(key, { at, timer });
  return true;
}

function cancel(key) {
  const existing = timers.get(key);
  if (existing) clearTimeout(existing.timer);
  timers.delete(key);
}

module.exports = { onTime, cancel, LOOK_AHEAD_MS };
