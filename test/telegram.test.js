const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused";
const { applicableKinds, effectivePrefs } = require("../src/services/telegram/prefs");
const f = require("../src/services/telegram/format");

test("each person gets the notification kinds that fit their job", () => {
  const operator = { role: "EMPLOYEE", employee: { job: "call_center", collectCalls: true, calendarAccess: "book", autoReport: true, reportTemplateId: 3 }, calendar: null };
  assert.deepEqual(applicableKinds(operator), ["appointments", "missedCalls", "digest", "materials", "tasks", "targets", "recordings", "followUps", "strikes"]);

  const clerk = { role: "EMPLOYEE", employee: { collectCalls: false, calendarAccess: "none", autoReport: false, reportTemplateId: 3 }, calendar: null };
  assert.deepEqual(applicableKinds(clerk), ["digest", "reportReminder", "materials", "tasks", "targets"]);

  const lawyer = { role: "LAWYER", employee: null, calendar: { active: true } };
  assert.deepEqual(applicableKinds(lawyer), ["appointments", "digest", "materials", "planning", "tasks", "cases", "followUps"]);

  const boss = { role: "BOSS", employee: null, calendar: null };
  assert.deepEqual(applicableKinds(boss), ["appointments", "digest", "tasks", "recordings", "cases", "followUps", "strikes"]);

  // A monitored phone that isn't the call center's: no call-back alerts.
  const coordinator = { role: "EMPLOYEE", employee: { job: "coordinator", collectCalls: true, calendarAccess: "none" }, calendar: null };
  assert.deepEqual(applicableKinds(coordinator), ["digest", "materials", "tasks", "targets", "recordings", "cases", "followUps"]);
});

test("everything is on until switched off, and unrelated saved keys are ignored", () => {
  const lawyer = { role: "LAWYER", employee: null, calendar: { active: true } };
  assert.deepEqual(effectivePrefs(lawyer, null), { appointments: true, digest: true, materials: true, planning: true, tasks: true, cases: true, followUps: true });
  assert.deepEqual(effectivePrefs(lawyer, { digest: false, missedCalls: false }), {
    appointments: true,
    digest: false,
    materials: true,
    planning: true,
    tasks: true,
    cases: true,
    followUps: true,
  });
});

test("messages are formatted in Uzbek and escaped", () => {
  assert.equal(f.day("2026-09-30"), "30-sentabr, chorshanba");
  assert.equal(f.relativeDay("2026-09-29", "2026-09-29"), "Bugun");
  assert.equal(f.relativeDay("2026-09-30", "2026-09-29"), "Ertaga");
  assert.equal(f.clock(570), "09:30");
  assert.equal(f.money(1500000), "1 500 000 soʻm");
  assert.equal(f.phoneCompact("90 123 45 67"), "+998901234567");
  assert.equal(f.escapeHtml("<b>A & B</b>"), "&lt;b&gt;A &amp; B&lt;/b&gt;");
});
