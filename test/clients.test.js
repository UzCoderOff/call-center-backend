const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused";
const cl = require("../src/services/clients");

test("search works in either script and ignores apostrophes", () => {
  assert.equal(cl.searchable("Абдуллаев Баҳром"), cl.searchable("abdullaev bahrom"));
  assert.equal(cl.searchable("Ғулом Ўроқов"), cl.searchable("G'ulom O'roqov"));
  assert.equal(cl.searchable("Karimova Dilnoza. Toshkent."), cl.searchable("karimova dilnoza toshkent"));
  const text = cl.buildSearchText({ name: "Ҳамидов Бобур", city: "Нурobod", phones: ["+998 90 123-45-67"], caseNumbers: ["A-12/26"] });
  assert.match(text, new RegExp(cl.searchable("Hamidov Bobur")));
  assert.equal(cl.searchable("Khurshid"), cl.searchable("Хуршид"));
  assert.match(text, /998901234567/);
  assert.match(text, /a 12 26/);
});

test("phone numbers are cleaned and de-duplicated", () => {
  const phones = cl.normalizePhones(["+998 90 123 45 67", "901234567", "  ", "+998 91 000 00 00"]);
  assert.deepEqual(
    phones.map((p) => p.phoneKey),
    ["901234567", "910000000"]
  );
  assert.throws(() => cl.normalizePhones(["1", "2", "3", "4", "5", "6"].map((n) => `99890000000${n}`)), /too many/);
});

test("a case is stamped when it first reaches a consultation and a contract", () => {
  const today = "2026-09-28";
  const created = cl.normalizeCase({ matter: "Meros" }, {}, today);
  assert.equal(created.startDate, today);
  assert.equal(created.consultationDate, today); // new cases start as a consultation

  const callAgain = cl.normalizeCase({ status: "call_again", startDate: "2026-09-01" }, {}, today);
  assert.equal(callAgain.consultationDate, undefined); // not a consultation yet

  const current = { id: 1, status: "consultation", startDate: "2026-09-01", consultationDate: "2026-09-01" };
  const signed = cl.normalizeCase({ status: "contract" }, current, today);
  assert.equal(signed.contractDate, today);
  assert.equal(signed.consultationDate, undefined); // already had one

  const again = cl.normalizeCase({ status: "contract" }, { ...current, status: "contract", contractDate: "2026-09-10" }, today);
  assert.equal(again.contractDate, undefined); // first contract date is kept
  assert.throws(() => cl.normalizeCase({ status: "won" }, {}, today), /invalid status/);
});

test("what's paid and what's left", () => {
  assert.deepEqual(cl.paymentSummary(15000000, [{ amount: 10000000 }]), { paid: 10000000, remaining: 5000000, state: "partial" });
  assert.deepEqual(cl.paymentSummary(15000000, []), { paid: 0, remaining: 15000000, state: "unpaid" });
  assert.deepEqual(cl.paymentSummary(450000, [{ amount: 450000 }]), { paid: 450000, remaining: 0, state: "paid" });
  assert.deepEqual(cl.paymentSummary(null, [{ amount: 450000 }]), { paid: 450000, remaining: 0, state: "none" });
  assert.throws(() => cl.normalizePayment({ amount: 0, date: "2026-09-28" }), /amount is required/);
  assert.equal(cl.normalizePayment({ amount: 450000, date: "2026-09-28" }).kind, "contract");
});
