const test = require("node:test");
const assert = require("node:assert/strict");
const { publicMessage, preview } = require("../src/services/chat");

const viewer = { id: 7 };
const author = { id: 3, username: "aziz", name: null, role: "EMPLOYEE", employee: { name: "Aziz Rahimov", active: true } };

test("a chat message as the portal sees it", () => {
  const m = { id: 10, authorId: 3, author, text: "Salom", createdAt: new Date(0), editedAt: null, deletedAt: null, eventAt: null, eventTitle: null };
  assert.deepEqual(publicMessage(m, viewer), {
    id: 10,
    text: "Salom",
    deleted: false,
    event: null,
    author: { id: 3, name: "Aziz Rahimov", role: "EMPLOYEE" },
    mine: false,
    createdAt: new Date(0),
    editedAt: null,
  });
  assert.equal(publicMessage(m, author).mine, true);
});

test("a deleted message keeps its place but not its text or event", () => {
  const m = { id: 11, authorId: 3, author, text: "sir", createdAt: new Date(0), editedAt: null, deletedAt: new Date(1), eventAt: new Date(2), eventTitle: "Majlis" };
  const shown = publicMessage(m, viewer);
  assert.equal(shown.text, "");
  assert.equal(shown.deleted, true);
  assert.equal(shown.event, null);
});

test("notification text: who wrote what, events by their title, long text cut", () => {
  assert.equal(preview({ text: "Ertaga keling" }, "Aziz"), "Aziz: Ertaga keling");
  assert.equal(preview({ text: "", eventAt: new Date(), eventTitle: "Majlis" }, "Boss"), "Boss: 📅 Majlis");
  assert.equal(preview({ text: "Salom" }, null), "Salom");
  const long = preview({ text: "x".repeat(500) }, "A");
  assert.equal(long.length, "A: ".length + 298);
  assert.ok(long.endsWith("…"));
});

test("live updates: a wait ends when the person's version moves, others' don't matter", async () => {
  const live = require("../src/services/live");
  const v0 = live.versionOf(501);
  const waiting = live.waitFor(501, v0, { ms: 2000 });
  live.bump([777]);
  live.bump([501]);
  const v1 = await waiting;
  assert.ok(v1 > v0);
  // Already newer than what the screen has: answered at once.
  assert.equal(await live.waitFor(501, v0, { ms: 2000 }), v1);
  // Nothing new: the wait ends with the same version.
  assert.equal(await live.waitFor(502, live.versionOf(502), { ms: 30 }), live.versionOf(502));
});

test("on time: due within the minute gets a timer, later ones wait for the minute's look", async () => {
  const { onTime, cancel } = require("../src/lib/onTime");
  let ran = 0;
  assert.equal(onTime("t:1", new Date(Date.now() + 10), () => ran++), true);
  assert.equal(onTime("t:2", new Date(Date.now() + 10 * 60 * 1000), () => ran++), false);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(ran, 1);
  cancel("t:2");
});
