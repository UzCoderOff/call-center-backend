const test = require("node:test");
const assert = require("node:assert/strict");

// The 2026-10-17 round: a booking is a consultation (old "bookings"
// targets), answers on tasks, "Ledger AI" as the author, new callers'
// outcomes, and Ledger AI's prompt staying the same within an answer.

test("an old target on the separate bookings measure stands for the consultations target", async () => {
  const m = require("../src/services/performanceMetrics");
  assert.equal(m.BUILTIN.includes("bookings"), false);
  assert.equal(m.parseKey("bookings"), null); // can't be set any more
  const rows = [
    { employeeId: 1, metric: "bookings", amount: 40, fromMonth: "2026-10" },
    { employeeId: 2, metric: "bookings", amount: 40, fromMonth: "2026-10" },
    { employeeId: 2, metric: "consultations", amount: 55, fromMonth: "2026-10" },
    { employeeId: 3, metric: "bookings", amount: 0, fromMonth: "2026-10" },
    { employeeId: 4, metric: "bookings", amount: 45, fromMonth: "2026-10" }, // newer than…
    { employeeId: 4, metric: "consultations", amount: 70, fromMonth: "2026-09" }, // …this one
  ];
  const db = { target: { findMany: async ({ where }) => rows.filter((r) => where.employeeId.in.includes(r.employeeId)) } };
  const position = { targetConsultations: 60 };
  const t = await m.targetsFor([{ id: 1, position }, { id: 2, position }, { id: 3, position }, { id: 4, position }], "2026-10", db);
  assert.deepEqual([...t.get(1)], [["consultations", 40]]); // theirs, over the position's
  assert.deepEqual([...t.get(2)], [["consultations", 55]]); // their own consultations target wins
  assert.deepEqual([...t.get(3)], [["consultations", 60]]); // "no bookings target" doesn't remove the position's
  assert.deepEqual([...t.get(4)], [["consultations", 45]]); // the newer of the two
});

test("a task that asks for an answer: its person can't tick it done without one", () => {
  const { answerMissing, publicTask } = require("../src/routes/tasks");
  const me = { id: 7 };
  const task = { id: 1, assigneeId: 7, needsAnswer: true, answer: null, doneAt: null };
  assert.equal(answerMissing(task, me, true), true);
  assert.equal(answerMissing({ ...task, answer: "Narx sabab" }, me, true), false);
  assert.equal(answerMissing(task, { id: 1 }, true), false); // a manager may tick it
  assert.equal(answerMissing({ ...task, needsAnswer: false }, me, true), false);
  assert.equal(answerMissing(task, me, false), false);
  // Ledger AI as who gave it; the person who confirmed it stays underneath.
  const out = publicTask({ ...task, viaAi: true, createdBy: { id: 2, username: "admin", role: "DEVELOPER" }, assignee: null, doneBy: null });
  assert.equal(out.createdBy.name, "Ledger AI");
  assert.equal(out.createdBy.id, 2);
  assert.equal(publicTask({ ...task, viaAi: false, createdBy: { id: 2, username: "admin" } }).createdBy.name, "admin");
});

test("Telegram: a task that asks for an answer has no tick button and says where to answer", () => {
  const { taskText, taskButton } = require("../src/services/telegram/listeners");
  const task = { id: 5, title: "Sababini yozing", dueAt: new Date("2026-10-18T13:00:00Z"), needsAnswer: true, answer: null, viaAi: true, createdBy: { username: "admin" } };
  assert.equal(taskButton(task), undefined);
  assert.ok(taskButton({ ...task, needsAnswer: false }).reply_markup);
  const text = taskText(task, "📌 Yangi vazifa");
  assert.match(text, /Berdi: Ledger AI/);
  assert.match(text, /javob yozasiz/);
});

// A database stand-in for the new-callers list.
function fakeDb({ calls, before = [], phones = [], outcomes = [], booked = [], staff = [], since = 0 }) {
  return {
    setting: { findUnique: async () => ({ value: { since } }), upsert: async () => ({}) },
    employee: { findMany: async () => staff.map((p) => ({ phoneNumber: p })) },
    callLog: {
      findMany: async ({ where }) =>
        where.callTimestampMs.lt !== undefined
          ? before.filter((k) => where.phoneKey.in.includes(k)).map((phoneKey) => ({ phoneKey }))
          : calls.map((c) => ({ ...c, callTimestampMs: BigInt(c.at), phoneNumber: c.phoneKey })),
    },
    clientPhone: { findMany: async () => phones },
    callOutcome: { findMany: async () => outcomes.map((phoneKey) => ({ phoneKey })) },
    appointment: { findMany: async () => booked.map((phoneKey) => ({ phoneKey })) },
  };
}

test("new callers to ask about: new numbers they talked to, not booked, not answered yet", async () => {
  require("../src/lib/settings").clearSettingsCache?.();
  const { pending } = require("../src/services/callOutcomes");
  const now = Date.parse("2026-10-17T10:00:00Z");
  const t = (h) => now - h * 60 * 60 * 1000;
  const talk = (phoneKey, at) => ({ phoneKey, at, missed: false, durationSeconds: 90, employeeId: 1 });
  const calls = [
    talk("901111111", t(5)), // new, talked -> asked
    { phoneKey: "902222222", at: t(4), missed: true, durationSeconds: 0, employeeId: 1 }, // never reached -> not asked
    talk("903333333", t(3)), // called before -> returning
    talk("904444444", t(3)), // has an outcome
    talk("905555555", t(2)), // booked
    talk("906666666", t(2)), // a client added since, case moved on
    talk("907777777", t(1)), // a staff phone
    talk("908888888", t(1)), // a client from before
    talk("901111111", t(1)), // the same new number again: one row, two calls
  ];
  const db = fakeDb({
    calls,
    before: ["903333333"],
    outcomes: ["904444444"],
    booked: ["905555555"],
    staff: ["+998 90 777 77 77"],
    phones: [
      { phoneKey: "906666666", client: { createdAt: new Date(t(1)), cases: [{ status: "call_again" }] } },
      { phoneKey: "908888888", client: { createdAt: new Date(t(100)), cases: [{ status: "consultation" }] } },
    ],
  });
  const rows = await pending({ employeeIds: [1], now, db });
  assert.deepEqual(rows.map((r) => r.phoneKey), ["901111111"]);
  assert.equal(rows[0].calls, 2);
  assert.equal(rows[0].employeeId, 1);
});

test("Ledger AI's instructions are the same within one answer: the time goes separately", () => {
  const { systemPrompt, TERMS } = require("../src/services/ai/assistant");
  const user = { role: "BOSS", name: "Rahbar" };
  const a = systemPrompt(user, { now: false });
  assert.equal(a, systemPrompt(user, { now: false }));
  assert.doesNotMatch(a, /Bugun:/);
  assert.match(systemPrompt(user), /Bugun:/); // the OpenAI path keeps it inline
  assert.ok(TERMS.some((line) => /bitta narsa/.test(line)));
});

test("a walk-in's summary is due from when it was entered, not from a time already past", () => {
  const { deadlineFor } = require("../src/services/consultSummary");
  const rule = { enabled: true, hours: 2 };
  const booked = { date: "2026-10-17", start: 600, end: 630, walkIn: false, createdAt: new Date("2026-10-16T09:00:00Z") };
  const late = { ...booked, walkIn: true, createdAt: new Date("2026-10-17T13:00:00Z") }; // 18:00 Tashkent
  assert.equal(deadlineFor(booked, rule).toISOString(), "2026-10-17T07:30:00.000Z"); // 10:30 + 2h, Tashkent
  assert.equal(deadlineFor(late, rule).toISOString(), "2026-10-17T15:00:00.000Z"); // entered 18:00 + 2h
});
