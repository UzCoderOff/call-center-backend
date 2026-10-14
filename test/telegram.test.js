const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused";
const { applicableKinds, effectivePrefs } = require("../src/services/telegram/prefs");
const f = require("../src/services/telegram/format");

test("each person gets the notification kinds that fit their job", () => {
  const operator = { role: "EMPLOYEE", employee: { job: "call_center", collectCalls: true, calendarAccess: "book", autoReport: true, reportTemplateId: 3 }, calendar: null };
  assert.deepEqual(applicableKinds(operator), ["appointments", "missedCalls", "digest", "materials", "tasks", "targets", "recordings", "followUps", "strikes", "chat", "news"]);

  const clerk = { role: "EMPLOYEE", employee: { collectCalls: false, calendarAccess: "none", autoReport: false, reportTemplateId: 3 }, calendar: null };
  assert.deepEqual(applicableKinds(clerk), ["digest", "reportReminder", "materials", "tasks", "targets", "chat", "news"]);

  const lawyer = { role: "LAWYER", employee: null, calendar: { active: true } };
  assert.deepEqual(applicableKinds(lawyer), ["appointments", "digest", "materials", "planning", "summaries", "tasks", "cases", "followUps", "chat", "calendar", "news"]);

  const boss = { role: "BOSS", employee: null, calendar: null };
  assert.deepEqual(applicableKinds(boss), ["appointments", "digest", "tasks", "recordings", "cases", "followUps", "strikes", "aiReports", "chat", "calendar", "news"]);

  // A monitored phone that isn't the call center's: no call-back alerts.
  const developer = { role: "DEVELOPER", employee: null, calendar: null };
  assert.ok(applicableKinds(developer).includes("deploys"));
  assert.ok(!applicableKinds(boss).includes("deploys"));

  const coordinator = { role: "EMPLOYEE", employee: { job: "coordinator", collectCalls: true, calendarAccess: "none" }, calendar: null };
  assert.deepEqual(applicableKinds(coordinator), ["digest", "materials", "tasks", "targets", "recordings", "cases", "followUps", "chat", "news"]);
});

test("everything is on until switched off, and unrelated saved keys are ignored", () => {
  const lawyer = { role: "LAWYER", employee: null, calendar: { active: true } };
  assert.deepEqual(effectivePrefs(lawyer, null), { appointments: true, digest: true, materials: true, planning: true, summaries: true, tasks: true, cases: true, followUps: true, chat: true, calendar: true, news: true });
  assert.deepEqual(effectivePrefs(lawyer, { digest: false, missedCalls: false }), {
    appointments: true,
    digest: false,
    materials: true,
    planning: true,
    summaries: true,
    tasks: true,
    cases: true,
    followUps: true,
    chat: true,
    calendar: true,
    news: true,
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

test("a Telegram message becomes an app notification: title, text, where a tap goes", () => {
  const env = require("../src/config/env");
  const { fromTelegram } = require("../src/services/notify");
  const saved = env.portalUrl;
  env.portalUrl = "https://portal.example";
  try {
    const n = fromTelegram('⏰ <b>Vazifa muddati keldi</b>\nMijoz: Aliyev &amp; Co\n<a href="https://portal.example/tasks">Ledgerda ochish</a>');
    assert.deepEqual(n, { title: "⏰ Vazifa muddati keldi", body: "Mijoz: Aliyev & Co", link: "/tasks" });
    // A link elsewhere is not a place to go.
    assert.equal(fromTelegram('Salom\n<a href="https://evil.example/x">bu yerda</a>').link, null);
    assert.deepEqual(fromTelegram("Faqat sarlavha"), { title: "Faqat sarlavha", body: null, link: null });
  } finally {
    env.portalUrl = saved;
  }
});

test("app notification links stay inside the portal", () => {
  const { cleanLink } = require("../src/services/notify");
  assert.equal(cleanLink("/chat/3"), "/chat/3");
  assert.equal(cleanLink("//evil.example"), null);
  assert.equal(cleanLink("https://evil.example"), null);
  assert.equal(cleanLink(null), null);
});
