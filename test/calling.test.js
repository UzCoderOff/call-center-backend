const test = require("node:test");
const assert = require("node:assert/strict");
const { hasCalls, collectsCalls, countsCalls, callsMatter, countedCallsWhere, CALL_JOBS } = require("../src/lib/calling");

// Everyone's calls are seen (2026-10-15); only the call center's and the
// coordinators' count (2026-10-14).
test("calls are seen for everyone, counted for the call center and coordinators only", () => {
  const phone = { collectCalls: true, pbxCalling: false, extraJobs: "" };
  for (const job of ["call_center", "coordinator", "office", "other"]) {
    assert.equal(hasCalls({ ...phone, job }), true, job);
    assert.equal(collectsCalls({ ...phone, job }), true, job);
  }
  assert.equal(countsCalls({ ...phone, job: "call_center" }), true);
  assert.equal(countsCalls({ ...phone, job: "coordinator" }), true);
  assert.equal(countsCalls({ ...phone, job: "office" }), false);
  assert.equal(countsCalls({ ...phone, job: "other" }), false);
  // An office worker who also coordinates: their calls count.
  assert.equal(countsCalls({ ...phone, job: "office", extraJobs: "coordinator" }), true);
  // The switch still matters.
  assert.equal(hasCalls({ ...phone, collectCalls: false, job: "call_center" }), false);
  assert.equal(countsCalls({ ...phone, collectCalls: false, job: "call_center" }), false);
  assert.equal(hasCalls({ collectCalls: false, pbxCalling: true, job: "office" }), true);
  assert.equal(countsCalls({ collectCalls: false, pbxCalling: true, job: "call_center" }), true);
  assert.equal(collectsCalls({ collectCalls: false, pbxCalling: true, job: "call_center" }), false);
  assert.equal(callsMatter(null), false);
  assert.equal(hasCalls(null), false);
});

test("the call log where: the phones of people with those jobs", () => {
  assert.deepEqual(CALL_JOBS, ["call_center", "coordinator"]);
  assert.deepEqual(countedCallsWhere(), {
    employee: { OR: [{ job: { in: ["call_center", "coordinator"] } }, { extraJobs: { contains: "call_center" } }, { extraJobs: { contains: "coordinator" } }] },
  });
  // Asking for office calls: none.
  assert.deepEqual(countedCallsWhere(["office"]), { employee: { OR: [{ job: { in: [] } }] } });
});
