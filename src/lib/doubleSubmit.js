// The same money form sent twice in a moment — a double tap, two tabs —
// must not record the money twice. An entry identical to one the same
// person saved this recently is taken to be that one: the earlier entry is
// the answer, nothing new is saved. (Checked inside the saving transaction:
// SQLite lets one save through at a time, so the second waits and sees it.)
const DOUBLE_SUBMIT_MS = 10 * 1000;

// For a `createdAt` condition: saved within the last few seconds.
const savedJustNow = (now = Date.now()) => ({ gte: new Date(now - DOUBLE_SUBMIT_MS) });

module.exports = { DOUBLE_SUBMIT_MS, savedJustNow };
