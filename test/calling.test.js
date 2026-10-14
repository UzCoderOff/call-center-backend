const test = require("node:test");
const assert = require("node:assert/strict");
const { hasCalls, collectsCalls, callsMatter, countedCallsWhere, CALL_JOBS } = require("../src/lib/calling");

// Only the call center's and the coordinators' calls matter (2026-10-14).
test("calls count for the call center and coordinators only", () => {
  const phone = { collectCalls: true, pbxCalling: false, extraJobs: "" };
  assert.equal(hasCalls({ ...phone, job: "call_center" }), true);
  assert.equal(hasCalls({ ...phone, job: "coordinator" }), true);
  assert.equal(hasCalls({ ...phone, job: "office" }), false);
  assert.equal(hasCalls({ ...phone, job: "other" }), false);
  // An office worker who also coordinates: their calls count.
  assert.equal(hasCalls({ ...phone, job: "office", extraJobs: "coordinator" }), true);
  // The switch still matters.
  assert.equal(hasCalls({ ...phone, collectCalls: false, job: "call_center" }), false);
  assert.equal(hasCalls({ collectCalls: false, pbxCalling: true, job: "call_center" }), true);
  assert.equal(collectsCalls({ collectCalls: false, pbxCalling: true, job: "call_center" }), false);
  assert.equal(collectsCalls({ ...phone, job: "office" }), false);
  assert.equal(callsMatter(null), false);
});

test("the call log where: the phones of people with those jobs", () => {
  assert.deepEqual(CALL_JOBS, ["call_center", "coordinator"]);
  assert.deepEqual(countedCallsWhere(), {
    employee: { OR: [{ job: { in: ["call_center", "coordinator"] } }, { extraJobs: { contains: "call_center" } }, { extraJobs: { contains: "coordinator" } }] },
  });
  // Asking for office calls: none.
  assert.deepEqual(countedCallsWhere(["office"]), { employee: { OR: [{ job: { in: [] } }] } });
});
