const test = require("node:test");
const assert = require("node:assert/strict");
const { jobOf, jobsOf, hasJob, isCallCenter, isCoordinator, jobFields, jobWhere, parseJobs } = require("../src/lib/jobs");

test("one job: what it always was", () => {
  const e = { job: "call_center", extraJobs: "" };
  assert.deepEqual(jobsOf(e), ["call_center"]);
  assert.equal(isCallCenter(e), true);
  assert.equal(isCoordinator(e), false);
});

test("two jobs: the main one first, both count", () => {
  const e = { job: "call_center", extraJobs: "coordinator" };
  assert.deepEqual(jobsOf(e), ["call_center", "coordinator"]);
  assert.equal(isCallCenter(e), true);
  assert.equal(isCoordinator(e), true);
  assert.equal(hasJob(e, "office"), false);
  assert.equal(jobOf(e), "call_center");
});

test("older rows without extraJobs, unknown and repeated values", () => {
  assert.deepEqual(jobsOf({ job: "office" }), ["office"]);
  assert.deepEqual(jobsOf({ job: "nonsense", extraJobs: "coordinator, office ,coordinator,bad" }), ["coordinator", "office"]);
  assert.deepEqual(jobsOf(null), ["other"]);
  assert.deepEqual(jobsOf({ job: "other", extraJobs: "" }), ["other"]);
});

test("'other' only stands when it's all they do", () => {
  assert.deepEqual(jobsOf({ job: "other", extraJobs: "coordinator" }), ["coordinator"]);
});

test("jobFields stores the first as the main job and the rest as extras", () => {
  assert.deepEqual(jobFields(["coordinator", "call_center"]), { job: "coordinator", extraJobs: "call_center" });
  assert.deepEqual(jobFields(["office"]), { job: "office", extraJobs: "" });
  assert.deepEqual(jobFields(["other", "office", "office"]), { job: "office", extraJobs: "" });
  assert.deepEqual(jobFields([]), { job: "other", extraJobs: "" });
  assert.deepEqual(jobFields("call_center,office"), { job: "call_center", extraJobs: "office" });
});

test("jobWhere matches the main job or an extra one", () => {
  assert.deepEqual(jobWhere(["call_center"]), { OR: [{ job: { in: ["call_center"] } }, { extraJobs: { contains: "call_center" } }] });
  // No job name is part of another, so `contains` can't match the wrong job.
  const names = ["call_center", "coordinator", "office", "other"];
  for (const a of names) for (const b of names) if (a !== b) assert.equal(b.includes(a), false, `${a} in ${b}`);
});

test("parseJobs keeps the valid ones from a query parameter", () => {
  assert.equal(parseJobs(undefined), null);
  assert.equal(parseJobs(""), null);
  assert.equal(parseJobs("bad"), null);
  assert.deepEqual(parseJobs("call_center,coordinator,call_center"), ["call_center", "coordinator"]);
});
