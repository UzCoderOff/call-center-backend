const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused-secret-for-tests";
const a = require("../src/lib/clientAccess");

const dev = { id: 1, role: "DEVELOPER", active: true };
const boss = { id: 2, role: "BOSS", active: true };
const lawyer = { id: 3, role: "LAWYER", active: true };
const operator = { id: 4, role: "EMPLOYEE", active: true, employee: { id: 7, job: "call_center" } };
const coordinator = { id: 6, role: "EMPLOYEE", active: true, employee: { id: 8, job: "coordinator" } };
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

test("staff open the clients they're operator or coordinator of, or added while nobody is", () => {
  assert.deepEqual(a.clientScope(operator), {
    OR: [
      { cases: { some: { operatorId: 7 } } },
      { cases: { some: { coordinatorId: 7 } } },
      { createdById: 4, cases: { none: { operatorId: { not: null } } } },
    ],
  });
  assert.deepEqual(a.ownCaseWhere(operator), { OR: [{ operatorId: 7 }, { coordinatorId: 7 }] });
  // An account without an employee record: nothing.
  assert.deepEqual(a.clientScope(noEmployee), { id: -1 });
  // Working on: an operator's consultations, not the contracts they brought in.
  assert.deepEqual(a.workScope(operator).OR[0], { cases: { some: { operatorId: 7, status: { notIn: ["contract", "done"] } } } });
});

test("at the contract a case changes hands: the operator keeps only the result", () => {
  const consultation = { id: 1, status: "consultation", operatorId: 7, coordinatorId: null, lawyerId: 3 };
  const signed = { id: 2, status: "contract", operatorId: 7, coordinatorId: 8, lawyerId: 3 };
  const finished = { id: 3, status: "done", operatorId: 7, coordinatorId: 8, lawyerId: null };
  const someoneElses = { id: 4, status: "consultation", operatorId: 99, coordinatorId: null, lawyerId: null };

  assert.equal(a.caseRole(operator, consultation), "operator");
  assert.equal(a.caseRole(operator, signed), "result");
  assert.equal(a.caseRole(operator, finished), "result");
  assert.equal(a.caseRole(operator, someoneElses), null);

  assert.equal(a.caseRole(coordinator, signed), "coordinator");
  assert.equal(a.caseRole(coordinator, consultation), null);
  assert.equal(a.caseRole(lawyer, signed), "lawyer");
  assert.equal(a.caseRole(lawyer, finished), null);
  assert.equal(a.caseRole(boss, someoneElses), "manager");

  // The client as a whole: the strongest role wins.
  const client = { id: 10, createdById: 2, cases: [signed] };
  assert.equal(a.clientLevel(operator, client).level, "result");
  assert.equal(a.clientLevel(coordinator, client).level, "coordinator");
  // Back with a new problem: a new consultation — they work on the client
  // again, the signed case stays a result.
  const back = { id: 10, createdById: 2, cases: [signed, { ...consultation, id: 5 }] };
  const level = a.clientLevel(operator, back);
  assert.equal(level.level, "operator");
  assert.equal(level.roles.get(2), "result");
  assert.equal(level.roles.get(5), "operator");
  // Nobody's: not visible.
  assert.equal(a.clientLevel(operator, { id: 11, createdById: 2, cases: [someoneElses] }).level, null);
});

test("whoever added a client works on it while it has no operator", () => {
  const fresh = { id: 12, createdById: 4, cases: [] };
  assert.equal(a.clientLevel(operator, fresh).level, "operator");
  const unassigned = { id: 13, createdById: 4, cases: [{ id: 6, status: "consultation", operatorId: null, coordinatorId: null, lawyerId: null }] };
  assert.equal(a.clientLevel(operator, unassigned).level, "operator");
  assert.equal(a.clientLevel(coordinator, unassigned).level, null);
});

test("someone else's client shows only whose it is — the coordinator once signed", () => {
  const shown = a.restricted({ id: 9, name: "Secret", cases: [{ operator: { name: "Aziz" } }, { operator: { name: "Aziz" }, coordinator: { name: "Emma" } }, { operator: null }] });
  assert.deepEqual(shown, { id: null, name: null, restricted: true, operator: "Aziz", coordinator: "Emma" });
  assert.equal(a.restricted({ id: 9, name: "Secret", cases: [] }).operator, null);
});
