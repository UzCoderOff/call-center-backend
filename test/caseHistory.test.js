const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused-secret-for-tests";
const h = require("../src/services/caseHistory");
const cl = require("../src/services/clients");
const { canSeeCaseMoney } = require("../src/lib/finance");
const { parseJobs, jobOf } = require("../src/lib/jobs");

const TODAY = "2026-10-02";

test("a stage row: a known stage, a real date not in the future", () => {
  assert.deepEqual(h.normalizeStage({ stage: "investigation", date: "2026-03-12", court: " Yunusobod IIB ", note: "" }, {}, TODAY), {
    stage: "investigation",
    date: "2026-03-12",
    court: "Yunusobod IIB",
    note: null,
  });
  // No date: today.
  assert.equal(h.normalizeStage({ stage: "appeal" }, {}, TODAY).date, TODAY);
  assert.throws(() => h.normalizeStage({ stage: "nonsense" }, {}, TODAY), /invalid stage/);
  assert.throws(() => h.normalizeStage({ stage: "appeal", date: "2026-02-30" }, {}, TODAY), /invalid date/);
  assert.throws(() => h.normalizeStage({ stage: "appeal", date: "2027-01-01" }, {}, TODAY), /future/);
  // Correcting one: only what's sent.
  assert.deepEqual(h.normalizeStage({ date: "2026-01-05" }, { id: 4, stage: "inquiry", date: "2026-01-01" }, TODAY), { date: "2026-01-05" });
});

test("the case's stage is the latest row — by date, then by entry; removed rows don't count", () => {
  const rows = [
    { id: 1, stage: "inquiry", date: "2026-01-10" },
    { id: 2, stage: "first_instance", date: "2026-06-01" },
    // Entered later, but dated earlier (history being filled in).
    { id: 3, stage: "sent_to_court", date: "2026-05-02" },
    { id: 4, stage: "appeal", date: "2026-09-01", deletedAt: new Date() },
  ];
  assert.equal(h.latestStage(rows).stage, "first_instance");
  // Same day: the one entered last.
  assert.equal(h.latestStage([...rows, { id: 5, stage: "appeal", date: "2026-06-01" }]).stage, "appeal");
  assert.equal(h.latestStage([]), null);
  assert.equal(h.latestStage([{ id: 1, stage: "inquiry", date: "2026-01-10", deletedAt: new Date() }]), null);
});

test("a key date: a known kind, a date, an optional time of day", () => {
  assert.deepEqual(h.normalizeKeyDate({ kind: "hearing", date: "2026-10-20", time: 600, title: "Birinchi majlis", place: "" }), {
    kind: "hearing",
    date: "2026-10-20",
    time: 600,
    title: "Birinchi majlis",
    place: null,
  });
  assert.throws(() => h.normalizeKeyDate({ kind: "party", date: "2026-10-20" }), /invalid kind/);
  assert.throws(() => h.normalizeKeyDate({ kind: "hearing", date: "20.10.2026" }), /invalid date/);
  assert.throws(() => h.normalizeKeyDate({ kind: "hearing", date: "2026-10-20", time: 1500 }), /invalid time/);
  // What happened, afterwards.
  assert.deepEqual(h.normalizeKeyDate({ outcome: "Keyinga qoldirildi" }, { id: 3 }), { outcome: "Keyinga qoldirildi" });
});

test("a case closes with a date, and reopens without one", () => {
  assert.equal(cl.normalizeCase({ status: "done" }, { id: 1, status: "contract" }, TODAY).closedDate, TODAY);
  assert.equal(cl.normalizeCase({ status: "declined" }, { id: 1, status: "consultation" }, TODAY).closedDate, TODAY);
  assert.equal(cl.normalizeCase({ status: "contract" }, { id: 1, status: "done", closedDate: "2026-09-01" }, TODAY).closedDate, null);
  // Already closed on a known day: kept.
  assert.equal(cl.normalizeCase({ status: "done" }, { id: 1, status: "done", closedDate: "2026-09-01" }, TODAY).closedDate, undefined);
});

test("a coordinator sees the money of their own cases only", () => {
  const coordinator = { id: 6, role: "EMPLOYEE", active: true, employee: { id: 8, job: "coordinator" } };
  const operator = { id: 4, role: "EMPLOYEE", active: true, employee: { id: 7, job: "call_center" } };
  const dev = { id: 1, role: "DEVELOPER", active: true };
  assert.equal(canSeeCaseMoney(coordinator, { coordinatorId: 8 }), true);
  assert.equal(canSeeCaseMoney(coordinator, { coordinatorId: 9 }), false);
  assert.equal(canSeeCaseMoney(operator, { coordinatorId: 8 }), false);
  assert.equal(canSeeCaseMoney(dev, { coordinatorId: null }), true);
});

test("jobs: known ones only", () => {
  assert.deepEqual(parseJobs("call_center,coordinator,nonsense"), ["call_center", "coordinator"]);
  assert.equal(parseJobs(""), null);
  assert.equal(parseJobs("nonsense"), null);
  assert.equal(jobOf({ job: "office" }), "office");
  assert.equal(jobOf({}), "other");
  assert.equal(jobOf(null), "other");
});
