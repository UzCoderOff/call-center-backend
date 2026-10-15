const test = require("node:test");
const assert = require("node:assert/strict");
const { NEWS, messageFor, parseDeployLog, deployMessage } = require("../src/services/news");

test("what's new: the boss gets the summary, staff only what touches their work, the developer nothing", () => {
  const news = NEWS.find((n) => n.id === "2026-10-14-calendars");
  const boss = { role: "BOSS", employee: null, calendar: null };
  const lawyer = { role: "LAWYER", employee: null, calendar: { active: true } };
  const operator = { role: "EMPLOYEE", employee: { job: "call_center", collectCalls: true, calendarAccess: "book", extraJobs: "" }, calendar: null };
  const office = { role: "EMPLOYEE", employee: { job: "office", collectCalls: true, calendarAccess: "none", extraJobs: "" }, calendar: null };
  const quiet = { role: "EMPLOYEE", employee: { job: "office", collectCalls: false, calendarAccess: "none", extraJobs: "" }, calendar: null };
  const developer = { role: "DEVELOPER", employee: null, calendar: null };

  assert.equal(messageFor(news, boss).split("\n").length, news.boss.length + 1);
  assert.match(messageFor(news, lawyer), /shaxsiy kalendaringiz/);
  assert.match(messageFor(news, operator), /tugmachalar/);
  assert.match(messageFor(news, office), /yuborilmaydi/);
  assert.equal(messageFor(news, quiet), null);
  assert.equal(messageFor(news, developer), null);
});

test("what's new 2026-10-15: the clients' Telegram — the boss and the call center", () => {
  const news = NEWS.find((n) => n.id === "2026-10-15-telegram-inbox");
  assert.equal(NEWS[0], news);
  const boss = { role: "BOSS" };
  const operator = { role: "EMPLOYEE", employee: { job: "call_center" } };
  const lawyer = { role: "LAWYER" };
  const office = { role: "EMPLOYEE", employee: { job: "office" } };
  assert.match(messageFor(news, boss), /beta/i);
  assert.match(messageFor(news, operator), /Mijozlar Telegrami/);
  assert.match(messageFor(news, { role: "EMPLOYEE", employee: { job: "coordinator" } }), /Mijozingiz firma Telegramiga yozsa/);
  assert.equal(messageFor(news, lawyer), null);
  assert.equal(messageFor(news, office), null);
});

test("what's new 2026-10-15: office calls back, who took the cash", () => {
  const news = NEWS.find((n) => n.id === "2026-10-15-office-calls-cash");
  assert.equal(NEWS[1], news);
  const operator = { role: "EMPLOYEE", employee: { job: "call_center", collectCalls: true, calendarAccess: "book", extraJobs: "" }, calendar: null };
  const office = { role: "EMPLOYEE", employee: { job: "office", collectCalls: true, calendarAccess: "none", extraJobs: "" }, calendar: null };
  const quiet = { role: "EMPLOYEE", employee: { job: "office", collectCalls: false, calendarAccess: "none", extraJobs: "" }, calendar: null };
  const lawyer = { role: "LAWYER", employee: null, calendar: { active: true } };
  assert.match(messageFor(news, office), /yana Ledger/);
  assert.doesNotMatch(messageFor(news, office), /Naqd/);
  assert.match(messageFor(news, operator), /Naqd pulni kim oldi/);
  assert.doesNotMatch(messageFor(news, operator), /yana Ledger/);
  assert.equal(messageFor(news, quiet), null);
  assert.match(messageFor(news, lawyer), /Mijozni ochsangiz, ishi shu yerda/);
  assert.doesNotMatch(messageFor(news, lawyer), /Naqd/);
  const coordinator = { role: "EMPLOYEE", employee: { job: "coordinator", collectCalls: false, calendarAccess: "none", extraJobs: "" }, calendar: null };
  assert.match(messageFor(news, coordinator), /Qarzlar/);
  const boss = messageFor(news, { role: "BOSS", employee: null, calendar: null });
  assert.match(boss, /Kassa/);
  assert.match(boss, /Kim boʻsh/);
});

test("the deploy log: recent releases, each with what happened", () => {
  const now = new Date("2026-10-14T15:00:00").getTime();
  const log = [
    "2026-10-14 09:47:15  OK deployed d12ccd2 — Boss's feedback",
    "2026-10-14 14:58:02  == New commit on GitHub: abc1234 Something",
    "   | Deployed: abc1234 Something",
    "2026-10-14 14:59:40  OK deployed abc1234 — Calendars & more",
    "2026-10-14 14:59:50  !! FAILED def5678 (exit 1). Now running: abc1234 x",
    "2026-10-14 14:59:55  !! HELD 9999999 — not deployed, server still on abc1234: a new migration may remove data",
  ].join("\n");
  const found = parseDeployLog(log, now);
  assert.deepEqual(
    found.map((d) => [d.kind, d.sha]),
    [
      ["ok", "abc1234"],
      ["failed", "def5678"],
      ["held", "9999999"],
    ]
  );
  assert.match(deployMessage(found[0]), /oʻrnatildi.*abc1234[\s\S]*Calendars &amp; more/);
  assert.match(deployMessage(found[1]), /oʻrnatilmadi/);
});
