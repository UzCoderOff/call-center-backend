const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused";
const cal = require("../src/services/calendar");
const { weekStartOf, isoWeekday } = require("../src/lib/firmTime");

const WEEK = "2026-09-28"; // a Monday
const H = (h, m = 0) => h * 60 + m;

test("the Monday of any date's week", () => {
  assert.equal(weekStartOf("2026-10-01"), WEEK); // Thursday
  assert.equal(weekStartOf("2026-10-04"), WEEK); // Sunday
  assert.equal(weekStartOf(WEEK), WEEK);
  assert.equal(isoWeekday("2026-10-04"), 7);
});

test("a week's plan is validated and sorted", () => {
  const blocks = cal.normalizeBlocks(
    [
      { date: "2026-09-29", start: H(14), end: H(17), kind: "available" },
      { date: WEEK, start: H(9), end: H(12), kind: "available" },
      { date: WEEK, start: H(12), end: H(13), kind: "break", note: "  tushlik " },
    ],
    WEEK
  );
  assert.deepEqual(
    blocks.map((b) => [b.date, b.start, b.kind]),
    [
      [WEEK, H(9), "available"],
      [WEEK, H(12), "break"],
      ["2026-09-29", H(14), "available"],
    ]
  );
  assert.equal(blocks[1].note, "tushlik");
});

test("bad plans are rejected", () => {
  assert.throws(() => cal.normalizeBlocks([{ date: "2026-10-05", start: H(9), end: H(10), kind: "available" }], WEEK), /not in this week/);
  assert.throws(() => cal.normalizeBlocks([{ date: WEEK, start: H(10), end: H(9), kind: "available" }], WEEK), /invalid time/);
  assert.throws(() => cal.normalizeBlocks([{ date: WEEK, start: H(9), end: H(10), kind: "party" }], WEEK), /unknown kind/);
  assert.throws(
    () =>
      cal.normalizeBlocks(
        [
          { date: WEEK, start: H(9), end: H(11), kind: "available" },
          { date: WEEK, start: H(10), end: H(12), kind: "busy" },
        ],
        WEEK
      ),
    /overlap/
  );
});

const CALENDAR = { workDays: "1,2,3,4,5", dayStart: H(9), dayEnd: H(18), lunchStart: H(12), lunchEnd: H(13), slotMinutes: 30 };

test("a new week is filled in from the usual week, lunch included", () => {
  const usual = cal.usualWeekOf(CALENDAR);
  const blocks = cal.usualWeekBlocks(usual, WEEK);
  assert.equal(new Set(blocks.map((b) => b.date)).size, 5); // Monday-Friday
  assert.deepEqual(
    blocks.filter((b) => b.date === WEEK).map((b) => [b.start, b.end, b.kind]),
    [
      [H(9), H(12), "available"],
      [H(12), H(13), "break"],
      [H(13), H(18), "available"],
    ]
  );
  // No lunch break: one block per day.
  const noLunch = cal.usualWeekBlocks({ ...usual, lunch: null, workDays: [6] }, WEEK);
  assert.deepEqual(noLunch, [{ date: "2026-10-03", start: H(9), end: H(18), kind: "available" }]);
});

test("the usual week is validated", () => {
  assert.deepEqual(cal.normalizeUsualWeek({ lunch: null, workDays: [6, 1, 1] }, CALENDAR), {
    workDays: "1,6",
    dayStart: H(9),
    dayEnd: H(18),
    lunchStart: null,
    lunchEnd: null,
  });
  assert.equal(cal.normalizeUsualWeek({ lunch: { start: H(13), end: H(14) } }, CALENDAR).lunchStart, H(13));
  assert.throws(() => cal.normalizeUsualWeek({ lunch: { start: H(8), end: H(9) } }, CALENDAR), /within working hours/);
  assert.throws(() => cal.normalizeUsualWeek({ dayStart: H(18), dayEnd: H(9) }, CALENDAR), /working hours/);
  assert.throws(() => cal.normalizeUsualWeek({ workDays: [0] }, CALENDAR), /weekdays/);
  assert.throws(() => cal.normalizeUsualWeek({ slotMinutes: 7 }, CALENDAR), /slotMinutes/);
});

test("free slots skip booked and past time", () => {
  const blocks = [{ date: WEEK, start: H(9), end: H(11), kind: "available" }];
  const appointments = [
    { date: WEEK, start: H(9, 30), end: H(10), status: "booked" },
    { date: WEEK, start: H(10), end: H(10, 30), status: "cancelled" },
  ];
  const slots = cal.freeSlots({ blocks, appointments, slotMinutes: 30, now: { date: WEEK, minutes: H(9, 10) } });
  // 9:00 is past, 9:30 booked, 10:00 free again (cancelled), 10:30 free.
  assert.deepEqual(
    slots.map((s) => s.start),
    [H(10), H(10, 30)]
  );
});

test("changing the plan reports appointments that would no longer fit", () => {
  const appointments = [
    { id: 1, date: WEEK, start: H(9), end: H(9, 30), status: "booked" },
    { id: 2, date: WEEK, start: H(15), end: H(15, 30), status: "booked" },
    { id: 3, date: WEEK, start: H(16), end: H(16, 30), status: "cancelled" },
  ];
  const newPlan = [{ date: WEEK, start: H(9), end: H(12), kind: "available" }];
  assert.deepEqual(
    cal.conflictingAppointments(newPlan, appointments).map((a) => a.id),
    [2]
  );
});

