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
