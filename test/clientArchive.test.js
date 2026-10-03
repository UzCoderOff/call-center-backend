const test = require("node:test");
const assert = require("node:assert/strict");
const { lastActivity, isDue } = require("../src/services/clientArchive");

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-03T09:00:00Z");
const today = "2026-10-03";
const opts = (extra = {}) => ({ now, days: 14, today, lastCallByKey: new Map(), ...extra });
const ago = (days) => new Date(now - days * DAY);

test("an old consultation typed in last week goes by its real date, not the day it was entered", () => {
  const client = { createdAt: ago(3), cases: [{ status: "consultation", consultationDate: "2026-08-20" }], events: [] };
  assert.equal(lastActivity(client), Date.parse("2026-08-20T12:00:00Z"));
  assert.equal(isDue(client, opts()), true);
});

test("a client with no date at all counts from the day they were entered — unless imported", () => {
  assert.equal(isDue({ createdAt: ago(3), cases: [{ status: "consultation" }], events: [] }, opts()), false);
  assert.equal(isDue({ createdAt: ago(20), cases: [{ status: "consultation" }], events: [] }, opts()), true);
  assert.equal(isDue({ createdAt: ago(1), cases: [], events: [{ kind: "import", createdAt: ago(1) }] }, opts()), true);
});

test("anything real that happened recently keeps them: a note, a status change, a call, a payment, a follow-up", () => {
  const old = { createdAt: ago(60), cases: [{ status: "consultation", consultationDate: "2026-07-01" }], phones: [{ phone: "+998 90 123 45 67" }] };
  assert.equal(isDue({ ...old, events: [{ kind: "note", createdAt: ago(2) }] }, opts()), false);
  assert.equal(isDue({ ...old, events: [{ kind: "status", createdAt: ago(5) }] }, opts()), false);
  assert.equal(isDue({ ...old, events: [] }, opts({ lastCallByKey: new Map([["901234567", now - 3 * DAY]]) })), false);
  assert.equal(isDue({ ...old, events: [], payments: [{ date: "2026-10-01" }] }, opts()), false);
  assert.equal(isDue({ ...old, events: [], followUps: [{ createdAt: ago(4) }] }, opts()), false);
  // Import, archive and removed notes are not activity.
  assert.equal(isDue({ ...old, events: [{ kind: "import", createdAt: ago(1) }, { kind: "note", createdAt: ago(1), deletedAt: ago(1) }] }, opts()), true);
});

test("never archived: a contract, an appointment ahead, a call planned ahead, kept on purpose", () => {
  const quiet = { createdAt: ago(90), cases: [{ status: "consultation", consultationDate: "2026-06-01" }], events: [] };
  assert.equal(isDue(quiet, opts()), true);
  assert.equal(isDue({ ...quiet, cases: [{ status: "contract", consultationDate: "2026-06-01" }] }, opts()), false);
  assert.equal(isDue({ ...quiet, appointments: [{ date: "2026-10-10", status: "booked" }] }, opts()), false);
  assert.equal(isDue({ ...quiet, appointments: [{ date: "2026-10-10", status: "cancelled" }] }, opts()), true);
  assert.equal(isDue({ ...quiet, nextCallAt: new Date(now + DAY) }, opts()), false);
  assert.equal(isDue({ ...quiet, keepUntil: new Date(now + 7 * DAY) }, opts()), false);
  assert.equal(isDue({ ...quiet, keepUntil: new Date(now - DAY) }, opts()), true);
  assert.equal(isDue({ ...quiet, archivedAt: ago(1) }, opts()), false);
});

test("the number of days decides", () => {
  const client = { createdAt: ago(60), cases: [{ status: "consultation", consultationDate: "2026-09-25" }], events: [] };
  assert.equal(isDue(client, opts({ days: 14 })), false);
  assert.equal(isDue(client, opts({ days: 7 })), true);
});
