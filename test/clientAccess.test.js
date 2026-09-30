const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused-secret-for-tests";
const a = require("../src/lib/clientAccess");

const dev = { id: 1, role: "DEVELOPER", active: true };
const boss = { id: 2, role: "BOSS", active: true };
const lawyer = { id: 3, role: "LAWYER", active: true };
const operator = { id: 4, role: "EMPLOYEE", active: true, employee: { id: 7 } };
const noEmployee = { id: 5, role: "EMPLOYEE", active: true, employee: null };

test("the developer and the boss see every client", () => {
  assert.deepEqual(a.clientScope(dev), {});
  assert.deepEqual(a.clientScope(boss), {});
  assert.deepEqual(a.ownCaseWhere(boss), {});
});

test("a lawyer sees the clients with a case of theirs", () => {
  assert.deepEqual(a.clientScope(lawyer), { cases: { some: { lawyerId: 3 } } });
  assert.deepEqual(a.ownCaseWhere(lawyer), { lawyerId: 3 });
});

test("staff see the clients they're the operator of, or added while nobody is", () => {
  assert.deepEqual(a.clientScope(operator), {
    OR: [
      { cases: { some: { operatorId: 7 } } },
      { createdById: 4, cases: { none: { operatorId: { not: null } } } },
    ],
  });
  assert.deepEqual(a.ownCaseWhere(operator), { operatorId: 7 });
  // An account without an employee record: nothing.
  assert.deepEqual(a.clientScope(noEmployee), { id: -1 });
  assert.deepEqual(a.ownCaseWhere(noEmployee), { operatorId: -1 });
});

test("someone else's client shows only whose it is", () => {
  const shown = a.restricted({ id: 9, name: "Secret", cases: [{ operator: { name: "Aziz" } }, { operator: { name: "Aziz" } }, { operator: null }] });
  assert.deepEqual(shown, { id: null, name: null, restricted: true, operator: "Aziz" });
  assert.equal(a.restricted({ id: 9, name: "Secret", cases: [] }).operator, null);
});
