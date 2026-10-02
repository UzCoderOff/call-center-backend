const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused-secret-for-tests";
const fu = require("../src/services/clientFollowUps");
const cl = require("../src/services/clients");

const NOW = new Date("2026-10-05T05:00:00Z").getTime();

test("a connected person: a name, how they're related, maybe a number and 'decides'", () => {
  const c = fu.normalizeContact({ name: " Valijon Karimov ", relation: "father", phone: "90 123 45 67", decides: true });
  assert.equal(c.name, "Valijon Karimov");
  assert.equal(c.relation, "father");
  assert.equal(c.phoneKey, "901234567");
  assert.equal(c.decides, true);
  assert.throws(() => fu.normalizeContact({ name: "", relation: "father" }), /name/);
  assert.throws(() => fu.normalizeContact({ name: "X", relation: "uncle-ish" }), /relation/);
  // Correcting one: only what's sent.
  assert.deepEqual(fu.normalizeContact({ note: "Narxni u hal qiladi" }, { id: 3 }), { note: "Narxni u hal qiladi" });
});

test("a follow-up: a kind, a time not absurdly far ahead, a note", () => {
  const f = fu.normalizeFollowUp({ kind: "decision", dueAt: "2026-10-08T05:00:00Z", note: "Otasi bilan maslahatlashadi" }, {}, NOW);
  assert.equal(f.kind, "decision");
  assert.equal(f.dueAt.toISOString(), "2026-10-08T05:00:00.000Z");
  assert.throws(() => fu.normalizeFollowUp({ kind: "decision", dueAt: "not a date" }, {}, NOW), /dueAt/);
  assert.throws(() => fu.normalizeFollowUp({ kind: "decision", dueAt: "2030-01-01T00:00:00Z" }, {}, NOW), /too far/);
  assert.throws(() => fu.normalizeFollowUp({ kind: "party", dueAt: "2026-10-08T05:00:00Z" }, {}, NOW), /kind/);
});

test("closing one: done with what came of it, or cancelled", () => {
  assert.deepEqual(fu.normalizeClose({ status: "done", outcome: "decided_yes", outcomeNote: "Shartnoma tuzadi" }), { status: "done", outcome: "decided_yes", outcomeNote: "Shartnoma tuzadi" });
  assert.deepEqual(fu.normalizeClose({ status: "cancelled" }), { status: "cancelled" });
  assert.throws(() => fu.normalizeClose({ status: "open" }), /status/);
  assert.throws(() => fu.normalizeClose({ status: "done", outcome: "maybe" }), /outcome/);
});

test("the client's next call is the earliest open follow-up", () => {
  const rows = [
    { status: "done", dueAt: "2026-10-01T05:00:00Z", note: "old" },
    { status: "open", dueAt: "2026-10-09T05:00:00Z", note: "later" },
    { status: "open", dueAt: "2026-10-07T05:00:00Z", note: "first" },
  ];
  assert.deepEqual(fu.nextCallOf(rows), { nextCallAt: new Date("2026-10-07T05:00:00Z"), nextCallNote: "first" });
  assert.deepEqual(fu.nextCallOf([{ status: "cancelled", dueAt: "2026-10-07T05:00:00Z" }]), { nextCallAt: null, nextCallNote: null });
});

test("a consultation that didn't continue keeps why; going on clears it", () => {
  assert.equal(cl.normalizeCase({ status: "declined", lostReason: "price" }, { id: 1, status: "consultation" }, "2026-10-05").lostReason, "price");
  assert.throws(() => cl.normalizeCase({ lostReason: "bad luck" }, { id: 1 }, "2026-10-05"), /lostReason/);
  const back = cl.normalizeCase({ status: "consultation" }, { id: 1, status: "declined", lostReason: "price", closedDate: "2026-10-01" }, "2026-10-05");
  assert.equal(back.lostReason, null);
  assert.equal(back.closedDate, null);
});
