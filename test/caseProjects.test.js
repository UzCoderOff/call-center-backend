const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused-secret-for-tests";
const { normalizeEntry, suggestDeadline, EntryError } = require("../src/services/caseEntries");
const { occurrences, repeatFields, rangeWhere } = require("../src/services/repeats");
const { hasPassed, OUTCOME_KINDS, outcomeLine } = require("../src/services/outcomes");

const TODAY = "2026-10-15";

test("a history entry with a type: its details, and the dates it sets", () => {
  const e = normalizeEntry({ type: "hearing", text: "Dalillar qabul qilindi", result: "postponed", on: "2026-10-14", next: { date: "2026-10-20", time: 600, place: "Shahar sudi" } }, TODAY);
  assert.equal(e.type, "hearing");
  assert.deepEqual(e.data, { type: "hearing", on: "2026-10-14", result: "postponed" });
  assert.deepEqual(e.next, { date: "2026-10-20", time: 600, place: "Shahar sudi", title: null });
  assert.equal(e.deadline, null);

  const d = normalizeEntry({ type: "decision", text: "Daʼvo qanoatlantirildi", result: "won", deadline: { date: "2026-11-14", title: "Apellyatsiya muddati" } }, TODAY);
  assert.equal(d.data.on, TODAY);
  assert.deepEqual(d.deadline, { date: "2026-11-14", time: null, place: null, title: "Apellyatsiya muddati" });

  const m = normalizeEntry({ type: "meeting", text: "Hujjatlar olindi", with: "Mijoz va otasi", fileId: "7" }, TODAY);
  assert.deepEqual(m.data, { type: "meeting", on: TODAY, with: "Mijoz va otasi", fileId: 7 });
  // A next date only for hearings; a deadline only for decisions.
  assert.equal(normalizeEntry({ type: "call", text: "x", next: { date: "2026-10-20" } }, TODAY).next, null);
});

test("history entries refuse nonsense", () => {
  const bad = (body) => assert.throws(() => normalizeEntry(body, TODAY), EntryError, JSON.stringify(body));
  bad({ type: "party", text: "x" });
  bad({ type: "hearing", text: "" });
  bad({ type: "hearing", text: "x", result: "won" });
  bad({ type: "hearing", text: "x", on: "2026-12-01" });
  bad({ type: "hearing", text: "x", on: "2026-10-14", next: { date: "2026-10-13" } });
  bad({ type: "hearing", text: "x", next: { date: "2026-10-20", time: 2000 } });
  bad({ type: "decision", text: "x", deadline: { date: "2026-11-14" } });
  bad({ type: "filed", text: "x", fileId: "abc" });
});

test("a decision's deadline: only from the days the firm saved", () => {
  assert.equal(suggestDeadline("2026-10-15", "first_instance", { first_instance: 30 }), "2026-11-14");
  assert.equal(suggestDeadline("2026-10-15", null, { _: 10 }), "2026-10-25");
  assert.equal(suggestDeadline("2026-10-15", "appeal", { first_instance: 30 }), null);
  assert.equal(suggestDeadline("2026-10-15", "appeal", {}), null);
  assert.equal(suggestDeadline("nonsense", "appeal", { appeal: 5 }), null);
});

test("repeating events fall on the right days", () => {
  // 2026-10-12 is a Monday.
  const weekly = { date: "2026-10-12", repeat: "weekly", repeatUntil: null };
  assert.deepEqual(occurrences(weekly, "2026-10-10", "2026-10-31"), ["2026-10-12", "2026-10-19", "2026-10-26"]);
  const workdays = { date: "2026-10-16", repeat: "workdays", repeatUntil: "2026-10-20" };
  // Friday, Saturday, (no Sunday), Monday, Tuesday.
  assert.deepEqual(occurrences(workdays, "2026-10-01", "2026-10-31"), ["2026-10-16", "2026-10-17", "2026-10-19", "2026-10-20"]);
  const daily = { date: "2026-10-14", repeat: "daily", repeatUntil: null, skipDates: ["2026-10-15"] };
  assert.deepEqual(occurrences(daily, "2026-10-14", "2026-10-17"), ["2026-10-14", "2026-10-16", "2026-10-17"]);
  assert.deepEqual(occurrences({ date: "2026-10-14", repeat: null }, "2026-10-01", "2026-10-31"), ["2026-10-14"]);
  assert.deepEqual(occurrences({ date: "2026-11-14", repeat: null }, "2026-10-01", "2026-10-31"), []);
  assert.ok(rangeWhere("2026-10-01", "2026-10-31").OR.length === 2);
});

test("repeat settings are checked", () => {
  assert.deepEqual(repeatFields({ repeat: "weekly", repeatUntil: "2026-12-31" }, "2026-10-12"), { repeat: "weekly", repeatUntil: "2026-12-31" });
  assert.deepEqual(repeatFields({ repeat: "none", repeatUntil: "2026-12-31" }, "2026-10-12"), { repeat: null, repeatUntil: null });
  assert.deepEqual(repeatFields({}, "2026-10-12"), {});
  assert.throws(() => repeatFields({ repeat: "yearly" }, "2026-10-12"));
  assert.throws(() => repeatFields({ repeat: "daily", repeatUntil: "2026-10-01" }, "2026-10-12"));
  assert.throws(() => repeatFields({ repeat: "daily", repeatUntil: "2028-10-01" }, "2026-10-12"));
});

test("a hearing has taken place: a day before, or half an hour after its time", () => {
  const now = { date: TODAY, minutes: 14 * 60 };
  assert.equal(hasPassed({ date: "2026-10-14", time: null }, now), true);
  assert.equal(hasPassed({ date: TODAY, time: 13 * 60 }, now), true);
  assert.equal(hasPassed({ date: TODAY, time: 13 * 60 + 45 }, now), false);
  assert.equal(hasPassed({ date: TODAY, time: null }, now), false);
  assert.equal(hasPassed({ date: TODAY, time: null }, { date: TODAY, minutes: 17 * 60 }), true);
  assert.equal(hasPassed({ date: "2026-10-16", time: 9 * 60 }, now), false);
  assert.ok(OUTCOME_KINDS.includes("hearing") && OUTCOME_KINDS.includes("interrogation") && !OUTCOME_KINDS.includes("deadline"));
});

test("the team's line about an outcome", () => {
  const line = outcomeLine({ kind: "hearing", date: "2026-10-15", time: 600 }, { result: "postponed", text: "Guvoh kelmadi", next: { date: "2026-10-20", time: 630, place: "Shahar sudi" } });
  assert.match(line, /^⚖️ Sud majlisi \(15-oktabr, payshanba, 10:00\): Keyinga qoldirildi\. Guvoh kelmadi/);
  assert.match(line, /Keyingi: 20-oktabr, seshanba, 10:30 · Shahar sudi$/);
});
