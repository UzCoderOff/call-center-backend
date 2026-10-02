const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused-secret-for-tests";
process.env.FIRM_TIMEZONE ??= "Asia/Tashkent";
const s = require("../src/services/strikes");

const rules = { ...s.STRIKE_DEFAULTS, enabled: true, minutes: 10, from: 9 * 60, to: 20 * 60, limit: 3 };
const everyDay = () => true;
// Tashkent is UTC+5: 10:00 there is 05:00Z.
const at = (iso) => new Date(iso).getTime();
const MIN = 60 * 1000;

test("in working hours: due ten minutes after the missed call", () => {
  const missed = at("2026-10-05T05:00:00Z"); // Mon 10:00
  assert.equal(s.deadlineFor(missed, rules, everyDay), missed + 10 * MIN);
});

test("outside working hours: due ten minutes after the next opening", () => {
  // 22:30 on Monday -> Tuesday 09:10.
  assert.equal(s.deadlineFor(at("2026-10-05T17:30:00Z"), rules, everyDay), at("2026-10-06T04:10:00Z"));
  // 07:00 on Monday -> Monday 09:10.
  assert.equal(s.deadlineFor(at("2026-10-05T02:00:00Z"), rules, everyDay), at("2026-10-05T04:10:00Z"));
  // A day off (Sunday 4 October): the next day they work.
  const notSunday = (date) => date !== "2026-10-04";
  assert.equal(s.deadlineFor(at("2026-10-04T06:00:00Z"), rules, notSunday), at("2026-10-05T04:10:00Z"));
});

test("a call-back: an outgoing call (even unanswered), or the client answered when calling again", () => {
  const missed = { callTimestampMs: BigInt(at("2026-10-05T05:00:00Z")), followUp: "pending" };
  const later = [
    { callType: "incoming", missed: true, durationSeconds: 0, callTimestampMs: BigInt(at("2026-10-05T05:02:00Z")) }, // missed again: no
    { callType: "outgoing", missed: false, durationSeconds: 0, callTimestampMs: BigInt(at("2026-10-05T05:07:00Z")) }, // tried: yes
    { callType: "incoming", missed: false, durationSeconds: 40, callTimestampMs: BigInt(at("2026-10-05T05:05:00Z")) }, // answered: yes, earlier
  ];
  assert.equal(s.firstResponse(missed, later), at("2026-10-05T05:05:00Z"));
  // Marked "handled" (reached another way) counts from when it was marked.
  assert.equal(s.firstResponse({ ...missed, followUp: "handled", followUpMarkedAt: new Date("2026-10-05T05:03:00Z") }, []), at("2026-10-05T05:03:00Z"));
  assert.equal(s.firstResponse(missed, []), null);
});

test("judged: in time -> ok; late -> strike; nothing yet -> wait for the phone to send its calls", () => {
  const t0 = at("2026-10-05T05:00:00Z");
  const missed = { callTimestampMs: BigInt(t0), followUp: "pending" };
  const call = (min) => ({ callType: "outgoing", missed: false, durationSeconds: 30, callTimestampMs: BigInt(t0 + min * MIN) });
  const base = { missed, rules, works: everyDay };
  assert.equal(s.judge({ ...base, later: [call(8)], lastSyncMs: null, now: t0 + 9 * MIN }).verdict, "ok");
  // Returned after 25 minutes: a strike, with when.
  const late = s.judge({ ...base, later: [call(25)], lastSyncMs: t0 + 26 * MIN, now: t0 + 60 * MIN });
  assert.equal(late.verdict, "strike");
  assert.equal(late.answeredAt, t0 + 25 * MIN);
  // Not returned, but the phone hasn't sent anything since: wait.
  assert.equal(s.judge({ ...base, later: [], lastSyncMs: t0 + 5 * MIN, now: t0 + 60 * MIN }).verdict, "wait");
  // Not returned, and the phone has sent its calls since the deadline (+ margin): a strike.
  assert.equal(s.judge({ ...base, later: [], lastSyncMs: t0 + 40 * MIN, now: t0 + 60 * MIN }).verdict, "strike");
  // Within the margin after the deadline: still wait (a colleague's call-back may be on its way).
  assert.equal(s.judge({ ...base, later: [], lastSyncMs: t0 + 40 * MIN, now: t0 + 15 * MIN }).verdict, "wait");
  // A phone silent for two days: no judgement.
  assert.equal(s.judge({ ...base, later: [], lastSyncMs: null, now: t0 + 3 * 24 * 60 * MIN }).verdict, "skip");
});

test("the rule: checked, and switching it on starts counting from then", () => {
  const now = new Date("2026-10-05T05:00:00Z");
  const on = s.normalizeRules({ enabled: true, minutes: 15, limit: 4, fine: 50000 }, s.STRIKE_DEFAULTS, now);
  assert.equal(on.since, now.toISOString());
  assert.equal(on.minutes, 15);
  // Saved again while on: still counting from the first time.
  assert.equal(s.normalizeRules({ minutes: 12 }, on, new Date("2026-11-01T00:00:00Z")).since, now.toISOString());
  assert.throws(() => s.normalizeRules({ minutes: 0 }, on), /minutes/);
  assert.throws(() => s.normalizeRules({ from: 1200, to: 600 }, on), /before/);
  assert.throws(() => s.normalizeRules({ enabled: "yes" }, on), /enabled/);
});
