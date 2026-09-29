const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused";
const m = require("../src/services/materials");

const operator = { id: 10, role: "EMPLOYEE", active: true, employee: { active: true, positionId: 1 } };
const clerk = { id: 11, role: "EMPLOYEE", active: true, employee: { active: true, positionId: 2 } };
const lawyer = { id: 20, role: "LAWYER", active: true, employee: null };
const boss = { id: 1, role: "BOSS", active: true, employee: null };

const material = (over = {}) => ({ id: 1, published: true, archivedAt: null, forEveryone: false, version: 1, audience: [], ...over });

test("a material reaches exactly the positions, roles and people it is for", () => {
  const forOperators = material({ audience: [{ positionId: 1 }] });
  assert.equal(m.inAudience(forOperators, operator), true);
  assert.equal(m.inAudience(forOperators, clerk), false);
  assert.equal(m.inAudience(forOperators, lawyer), false);

  const forLawyers = material({ audience: [{ role: "LAWYER" }] });
  assert.equal(m.inAudience(forLawyers, lawyer), true);
  assert.equal(m.inAudience(forLawyers, operator), false);

  const forOnePerson = material({ audience: [{ userId: 11 }] });
  assert.equal(m.inAudience(forOnePerson, clerk), true);
  assert.equal(m.inAudience(forOnePerson, operator), false);

  const forEveryone = material({ forEveryone: true });
  assert.ok([operator, clerk, lawyer].every((p) => m.inAudience(forEveryone, p)));
});

test("people who left never count, and managers only when named", () => {
  const forEveryone = material({ forEveryone: true });
  assert.equal(m.inAudience(forEveryone, { ...operator, active: false }), false);
  assert.equal(m.inAudience(forEveryone, { ...operator, employee: { active: false, positionId: 1 } }), false);
  assert.equal(m.inAudience(forEveryone, boss), false);
  assert.equal(m.inAudience(material({ audience: [{ userId: 1 }] }), boss), true);
});

test("staff see only published, unarchived materials meant for them; managers see all", () => {
  const forOperators = material({ audience: [{ positionId: 1 }] });
  assert.equal(m.canSee(forOperators, operator), true);
  assert.equal(m.canSee({ ...forOperators, published: false }, operator), false);
  assert.equal(m.canSee({ ...forOperators, archivedAt: new Date() }, operator), false);
  assert.equal(m.canSee(forOperators, clerk), false);
  assert.equal(m.canSee({ ...forOperators, published: false, archivedAt: new Date() }, boss), true);
});

test("'read it again' makes older reads not count", () => {
  assert.equal(m.isRead(material({ version: 1 }), { version: 1 }), true);
  assert.equal(m.isRead(material({ version: 2 }), { version: 1 }), false);
  assert.equal(m.isRead(material(), null), false);
});

test("the editor's input is checked", () => {
  assert.deepEqual(m.normalizeMaterial({ title: "  Skript  ", required: true }, { creating: true }), { title: "Skript", required: true });
  assert.throws(() => m.normalizeMaterial({}, { creating: true }), /title is required/);
  assert.throws(() => m.normalizeMaterial({ title: "x", linkUrl: "javascript:alert(1)" }), /invalid linkUrl/);
  assert.equal(m.normalizeMaterial({ linkUrl: "https://youtu.be/abc" }).linkUrl, "https://youtu.be/abc");
  assert.equal(m.normalizeMaterial({ category: "" }).category, null);
  assert.throws(() => m.normalizeMaterial({ required: "yes" }), /invalid required/);

  assert.deepEqual(m.normalizeAudience({ positionIds: [1, "2", 2], roles: ["LAWYER"], userIds: [] }), [
    { positionId: 1 },
    { positionId: 2 },
    { role: "LAWYER" },
  ]);
  assert.throws(() => m.normalizeAudience({ roles: ["DEVELOPER"] }), /roles/);
  assert.throws(() => m.normalizeAudience({ positionIds: [0] }), /positionIds/);
  assert.equal(m.normalizeAudience(undefined), undefined);
  assert.deepEqual(m.audienceOf([{ positionId: 3 }, { role: "LAWYER" }, { userId: 9 }]), { positionIds: [3], roles: ["LAWYER"], userIds: [9] });
});

test("only safe file types, typed by extension, with clean names", () => {
  assert.equal(m.fileTypeOf("Skript.PDF").kind, "pdf");
  assert.equal(m.fileTypeOf("yaxshi-qongiroq.amr").convert, true);
  assert.equal(m.fileTypeOf("page.html"), null);
  assert.equal(m.fileTypeOf("logo.svg"), null);
  assert.equal(m.fileTypeOf("noextension"), null);
  assert.equal(m.cleanFileName("C:\\Users\\x\\Skript v2.docx"), "Skript v2.docx");
  assert.equal(m.cleanFileName('../../a"b\n.pdf'), "ab.pdf");
  const long = m.cleanFileName(`${"a".repeat(300)}.pdf`);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith(".pdf"));
});
