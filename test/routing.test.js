const test = require("node:test");
const assert = require("node:assert/strict");
const { ownerOf, lostSince, nextInTurn, cleanFollowUp } = require("../src/services/callOutcomes");

const DAY = 24 * 60 * 60 * 1000;

test("a caller thinking it over rings their operator until two days past their day", () => {
  const row = { outcome: "call_again", employeeId: 4, followUpOn: "2026-10-26", createdAt: new Date("2026-10-24T08:00:00Z") };
  assert.deepEqual(ownerOf(row, "2026-10-25"), { employeeId: 4, kind: "thinking" });
  assert.deepEqual(ownerOf(row, "2026-10-28"), { employeeId: 4, kind: "thinking" });
  assert.equal(ownerOf(row, "2026-10-29"), null);
  // Lost the day after that; the second chance comes `days` later.
  assert.equal(lostSince(row, "2026-10-29"), "2026-10-29");
});

test("a lost caller given a second chance rings the second operator for 30 days", () => {
  const at = new Date("2026-10-27T10:00:00Z");
  const row = { outcome: "price", employeeId: 4, secondEmployeeId: 7, secondAt: at, createdAt: new Date("2026-10-24T08:00:00Z") };
  assert.deepEqual(ownerOf(row, "2026-10-28", at.getTime() + DAY), { employeeId: 7, kind: "second" });
  assert.equal(ownerOf(row, "2026-12-01", at.getTime() + 31 * DAY), null);
  // A price "no" is lost from the day it was said; a wrong number never is.
  assert.equal(lostSince(row), "2026-10-24");
  assert.equal(lostSince({ ...row, outcome: "wrong_number" }), null);
  assert.equal(ownerOf({ outcome: "price", employeeId: 4 }), null);
});

test("second chances go round the operators in turn, never back to the first one", () => {
  const ids = [9, 3, 5];
  assert.equal(nextInTurn(ids, null, 3), 5);
  assert.equal(nextInTurn(ids, 5, 3), 9);
  assert.equal(nextInTurn(ids, 9, 3), 5);
  assert.equal(nextInTurn(ids, 9, 5), 3);
  assert.equal(nextInTurn([3], null, 3), null);
});

test("the day to talk again is tomorrow up to 30 days ahead", () => {
  assert.equal(cleanFollowUp("2026-10-26", "2026-10-24"), "2026-10-26");
  assert.equal(cleanFollowUp("2026-10-24", "2026-10-24"), null);
  assert.equal(cleanFollowUp("2026-12-24", "2026-10-24"), null);
  assert.equal(cleanFollowUp("26.10.2026", "2026-10-24"), null);
});
