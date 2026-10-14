const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused-secret-for-tests";
const s = require("../src/services/consultSummary");
const cl = require("../src/services/clients");

const NOW = new Date("2026-10-14T07:00:00Z").getTime();

test("a summary: a conclusion, and whether the client is a potential one", () => {
  const out = s.normalizeSummary({ topic: " Ish haqi undirish ", advice: "Daʼvo arizasi", conclusion: " Shartnoma narxini oilasi bilan gaplashadi ", prospect: "potential", next: { kind: "decision", dueAt: "2026-10-17T05:00:00Z" } }, NOW);
  assert.equal(out.topic, "Ish haqi undirish");
  assert.equal(out.conclusion, "Shartnoma narxini oilasi bilan gaplashadi");
  assert.deepEqual(out.next, { kind: "decision", dueAt: "2026-10-17T05:00:00.000Z", note: null, contactId: null });
  assert.equal(out.lostReason, null);
  assert.throws(() => s.normalizeSummary({ prospect: "potential", next: { kind: "contract" } }, NOW), /conclusion/);
  assert.throws(() => s.normalizeSummary({ conclusion: "x", prospect: "maybe" }, NOW), /prospect/);
});

test("potential: a next step — signed now needs no date, the others do", () => {
  assert.equal(s.normalizeSummary({ conclusion: "Imzoladi", prospect: "potential", next: { kind: "contract" } }, NOW).next.dueAt, null);
  assert.throws(() => s.normalizeSummary({ conclusion: "x", prospect: "potential", next: { kind: "call" } }, NOW), /date is required/);
  assert.throws(() => s.normalizeSummary({ conclusion: "x", prospect: "potential", next: { kind: "call", dueAt: "2026-10-01T05:00:00Z" } }, NOW), /past/);
  assert.throws(() => s.normalizeSummary({ conclusion: "x", prospect: "potential", next: { kind: "call", dueAt: "2028-10-01T05:00:00Z" } }, NOW), /too far/);
  assert.throws(() => s.normalizeSummary({ conclusion: "x", prospect: "potential", next: { kind: "later" } }, NOW), /next step/);
  assert.throws(() => s.normalizeSummary({ conclusion: "x", prospect: "potential" }, NOW), /next step/);
});

test("not potential: why (one of the lost reasons)", () => {
  const out = s.normalizeSummary({ conclusion: "Bizning soha emas", prospect: "not_potential", lostReason: "not_our_field", lostNote: "Oilaviy ish" }, NOW);
  assert.equal(out.next, null);
  assert.equal(out.lostReason, "not_our_field");
  assert.equal(out.lostNote, "Oilaviy ish");
  assert.throws(() => s.normalizeSummary({ conclusion: "x", prospect: "not_potential" }, NOW), /lost reason/);
  for (const r of cl.LOST_REASONS) assert.equal(s.normalizeSummary({ conclusion: "x", prospect: "not_potential", lostReason: r }, NOW).lostReason, r);
});

test("which consultations still need a summary", () => {
  const now = { date: "2026-10-14", minutes: 15 * 60 };
  const a = (over) => ({ date: "2026-10-14", start: 600, end: 630, status: "booked", summaryAt: null, ...over });
  assert.equal(s.needsSummary(a(), now), true, "booked, over, nobody marked it");
  assert.equal(s.needsSummary(a({ start: 16 * 60, end: 16 * 60 + 30 }), now), false, "still ahead");
  assert.equal(s.needsSummary(a({ start: 16 * 60, end: 16 * 60 + 30, status: "attended" }), now), true, "marked attended early");
  assert.equal(s.needsSummary(a({ status: "no_show" }), now), false);
  assert.equal(s.needsSummary(a({ status: "cancelled" }), now), false);
  assert.equal(s.needsSummary(a({ summaryAt: new Date() }), now), false);
  assert.equal(s.needsSummary(a({ date: "2026-10-13", start: 17 * 60, end: 18 * 60 }), now), true, "yesterday's");
});

test("the deadline: by the end of that day, or so many hours after it ended", () => {
  const a = { date: "2026-10-14", start: 600, end: 630 };
  // Tashkent is UTC+5: the end of 14 October there is 18:59:59 UTC.
  assert.equal(s.deadlineFor(a, { hours: null }).toISOString().slice(0, 16), "2026-10-14T18:59");
  // 10:30 Tashkent = 05:30 UTC; + 2 hours.
  assert.equal(s.deadlineFor(a, { hours: 2 }).toISOString().slice(0, 16), "2026-10-14T07:30");
});

test("the rule: switching it on starts counting from then", () => {
  const at = new Date("2026-10-14T10:00:00Z");
  const on = s.normalizeRule({ enabled: true, hours: 3, limit: 2 }, s.RULE_DEFAULTS, at);
  assert.equal(on.enabled, true);
  assert.equal(on.since, at.toISOString());
  assert.equal(on.hours, 3);
  // On already: "since" stays.
  assert.equal(s.normalizeRule({ enabled: true }, on, new Date("2026-11-01T00:00:00Z")).since, at.toISOString());
  assert.equal(s.normalizeRule({ hours: "" }, on).hours, null);
  assert.throws(() => s.normalizeRule({ hours: 0 }, on), /hours/);
  assert.throws(() => s.normalizeRule({ enabled: "yes" }, on), /enabled/);
});

test("who may write it: the specialist who held it, the boss, the developer", () => {
  const a = { calendar: { ownerId: 7 } };
  assert.equal(s.mayWrite({ id: 7, role: "LAWYER" }, a), true);
  assert.equal(s.mayWrite({ id: 8, role: "LAWYER" }, a), false);
  assert.equal(s.mayWrite({ id: 9, role: "EMPLOYEE" }, a), false);
  assert.equal(s.mayWrite({ id: 1, role: "BOSS" }, a), true);
  assert.equal(s.mayWrite({ id: 2, role: "DEVELOPER" }, a), true);
});
