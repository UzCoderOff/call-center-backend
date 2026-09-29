const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused-secret-for-tests";
const f = require("../src/lib/finance");
const throttle = require("../src/lib/loginThrottle");

test("only the developer and boss/lawyer accounts with the switch see client money", () => {
  assert.equal(f.canSeeFinance({ role: "DEVELOPER", active: true }), true);
  assert.equal(f.canSeeFinance({ role: "BOSS", active: true, seesFinance: true }), true);
  assert.equal(f.canSeeFinance({ role: "BOSS", active: true, seesFinance: false }), false);
  assert.equal(f.canSeeFinance({ role: "LAWYER", active: true, seesFinance: false }), false);
  assert.equal(f.canSeeFinance({ role: "LAWYER", active: true, seesFinance: true }), true);
  // Staff never, even if the flag were somehow set.
  assert.equal(f.canSeeFinance({ role: "EMPLOYEE", active: true, seesFinance: true }), false);
  assert.equal(f.canSeeFinance({ role: "BOSS", active: false, seesFinance: true }), false);
  assert.equal(f.canSeeFinance(null), false);
});

test("contract money is taken out; the consultation fee stays", () => {
  const fee = { amount: 450000, kind: "consultation" };
  const contract = { amount: 5000000, kind: "contract" };
  const k = { id: 1, status: "contract", contractAmount: 9000000, payments: [fee, contract], paid: 5450000, remaining: 3550000, state: "partial", matter: "Meros" };
  assert.deepEqual(f.caseWithoutMoney(k), { id: 1, status: "contract", matter: "Meros", payments: [fee] });
  assert.equal(f.caseWithoutMoney(null), null);

  const staff = { role: "EMPLOYEE", active: true };
  const ceo = { role: "BOSS", active: true, seesFinance: true };
  assert.deepEqual(f.visiblePayments(staff, [fee, contract, { amount: 1, kind: "other" }]), [fee]);
  assert.equal(f.visiblePayments(ceo, [fee, contract]).length, 2);

  const day = { booked: 2, payments: { count: 2, amount: 5450000 }, consultationPayments: { count: 1, amount: 450000 } };
  assert.deepEqual(f.consultationPaymentsOnly(day), { booked: 2, payments: { count: 1, amount: 450000 } });
  assert.deepEqual(f.allPayments(day), { booked: 2, payments: { count: 2, amount: 5450000 } });
});

function fakeReq(cookies = {}) {
  return { cookies, ip: "127.0.0.1" };
}
function fakeRes() {
  const set = {};
  return { set, cookie: (name, value) => (set[name] = value) };
}

test("a stranger's wrong passwords don't lock the owner out of their usual device", () => {
  const user = `boss-${Date.now()}`;
  // The owner signs in once from their phone: it becomes a known device.
  const res = fakeRes();
  throttle.recordSuccess(fakeReq(), res, user);
  const [cookieName] = Object.keys(res.set);
  assert.match(cookieName, /^kd_/);
  const ownPhone = fakeReq({ [cookieName]: res.set[cookieName] });

  // Someone else types the password wrong again and again.
  for (let i = 0; i < throttle.MAX_FAILURES; i++) throttle.recordFailure(fakeReq(), user);
  assert.equal(throttle.isBlocked(fakeReq(), user), true, "strangers are stopped");
  assert.equal(throttle.isBlocked(ownPhone, user), false, "the owner's phone is not");

  // A made-up or borrowed cookie doesn't count as known.
  assert.equal(throttle.isBlocked(fakeReq({ [cookieName]: "abc.def" }), user), true);
  const other = fakeRes();
  throttle.recordSuccess(fakeReq(), other, `someone-else-${Date.now()}`);
  const [otherName] = Object.keys(other.set);
  assert.equal(throttle.isBlocked(fakeReq({ [cookieName]: other.set[otherName] }), user), true);

  // The known device has its own allowance.
  for (let i = 0; i < throttle.MAX_FAILURES; i++) throttle.recordFailure(ownPhone, user);
  assert.equal(throttle.isBlocked(ownPhone, user), true);
});
