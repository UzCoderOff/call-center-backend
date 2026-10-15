const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused-secret-for-tests";
const { holderOf, heldWhere, cashHolderId, CASH_FROM } = require("../src/services/cash");

// Kassa: cash is with whoever took it (2026-10-15) — the person named on the
// payment, else whoever recorded it.
test("a cash payment is with whoever took it, else whoever recorded it", () => {
  assert.equal(holderOf({ recordedById: 4, cashHolderId: null }), 4);
  assert.equal(holderOf({ recordedById: 4, cashHolderId: 2 }), 2);
  assert.deepEqual(heldWhere([4]), {
    method: "cash",
    date: { gte: CASH_FROM },
    OR: [{ cashHolderId: { in: [4] } }, { cashHolderId: null, recordedById: { in: [4] } }],
  });
});

test("who took the cash, from a request", async () => {
  const people = {
    2: { active: true, role: "BOSS", employee: null },
    3: { active: true, role: "LAWYER", employee: null },
    5: { active: true, role: "EMPLOYEE", employee: { active: true } },
    6: { active: true, role: "EMPLOYEE", employee: { active: false } },
    9: { active: false, role: "LAWYER", employee: null },
  };
  const db = { user: { findUnique: async ({ where }) => people[where.id] ?? null } };
  assert.equal(await cashHolderId(undefined, 4, {}, db), undefined);
  // "me", nothing, or the recorder themselves: stored as "whoever recorded it".
  for (const v of ["me", null, "", 4, "4"]) assert.equal(await cashHolderId(v, 4, {}, db), null, String(v));
  // The forms: the boss or a lawyer.
  assert.equal(await cashHolderId(2, 4, {}, db), 2);
  assert.equal(await cashHolderId("3", 4, {}, db), 3);
  await assert.rejects(cashHolderId(5, 4, {}, db), /invalid cashWith/);
  // Kassa: anyone working here.
  assert.equal(await cashHolderId(5, 4, { any: true }, db), 5);
  // Someone switched off, someone unknown, nonsense: refused.
  for (const v of [6, 9, 77, "boss", -1, 1.5]) await assert.rejects(cashHolderId(v, 4, { any: true }, db), /invalid cashWith/, String(v));
});
