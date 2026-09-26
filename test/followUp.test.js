const test = require("node:test");
const assert = require("node:assert/strict");
const { computeFollowUps, FOLLOW_UP_WINDOW_MS } = require("../src/services/followUp");

const MIN = 60 * 1000;
const T0 = 1_780_000_000_000;

let nextId = 1;
function call(overrides) {
  return {
    id: nextId++,
    callType: "incoming",
    missed: false,
    durationSeconds: 60,
    followUp: null,
    ...overrides,
    callTimestampMs: BigInt(T0 + (overrides.at ?? 0)),
  };
}
const missed = (at, extra = {}) => call({ at, callType: "missed", missed: true, durationSeconds: 0, followUp: "pending", ...extra });
const outgoing = (at, durationSeconds = 90) => call({ at, callType: "outgoing", durationSeconds });
const incoming = (at, durationSeconds = 90) => call({ at, callType: "incoming", durationSeconds });

test("a connected outgoing call after a missed call is a callback, with its delay", () => {
  const m = missed(0);
  const cb = outgoing(12 * MIN);
  const r = computeFollowUps([cb, m]).get(m.id);
  assert.deepEqual(r, { followUp: "called_back", followUpCallId: cb.id, followUpDelaySec: 12 * 60 });
});

test("an unanswered callback is 'attempted' until a later one connects", () => {
  const m = missed(0);
  const tryOnce = outgoing(5 * MIN, 0);
  assert.equal(computeFollowUps([m, tryOnce]).get(m.id).followUp, "attempted");

  const connected = outgoing(40 * MIN, 30);
  const r = computeFollowUps([m, tryOnce, connected]).get(m.id);
  assert.equal(r.followUp, "called_back");
  assert.equal(r.followUpCallId, connected.id);
});

test("the caller ringing again and being answered also counts as reached", () => {
  const m = missed(0);
  const again = incoming(20 * MIN);
  assert.equal(computeFollowUps([m, again]).get(m.id).followUp, "client_called_again");
});

test("repeated missed calls stay pending, then one callback resolves all of them", () => {
  const m1 = missed(0);
  const m2 = missed(3 * MIN);
  let r = computeFollowUps([m1, m2]);
  assert.equal(r.get(m1.id).followUp, "pending");
  assert.equal(r.get(m2.id).followUp, "pending");

  const cb = outgoing(10 * MIN);
  r = computeFollowUps([m1, m2, cb]);
  assert.equal(r.get(m1.id).followUpDelaySec, 10 * 60);
  assert.equal(r.get(m2.id).followUpDelaySec, 7 * 60);
});

test("calls before the missed call, or outside the window, don't count", () => {
  const before = outgoing(-30 * MIN);
  const m = missed(0);
  const tooLate = outgoing(FOLLOW_UP_WINDOW_MS + MIN);
  assert.equal(computeFollowUps([before, m, tooLate]).get(m.id).followUp, "pending");
});

test("a manual 'handled' mark survives recomputation, but a real callback replaces it", () => {
  const m = missed(0, { followUp: "handled" });
  assert.equal(computeFollowUps([m]).get(m.id).followUp, "handled");
  assert.equal(computeFollowUps([m, outgoing(5 * MIN, 0)]).get(m.id).followUp, "handled");
  assert.equal(computeFollowUps([m, outgoing(5 * MIN)]).get(m.id).followUp, "called_back");
});

test("non-missed calls get no follow-up status", () => {
  const answered = incoming(0);
  assert.equal(computeFollowUps([answered, outgoing(MIN)]).has(answered.id), false);
});
