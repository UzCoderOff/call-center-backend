const test = require("node:test");
const assert = require("node:assert/strict");
const { phoneKey } = require("../src/lib/phone");

test("the same Uzbek number in every common format gets the same key", () => {
  const formats = ["+998 90 123 45 67", "998901234567", "901234567", "+998(90)123-45-67", "8 90 123 45 67"];
  for (const f of formats) assert.equal(phoneKey(f), "901234567", f);
});

test("different numbers get different keys", () => {
  assert.notEqual(phoneKey("+998901234567"), phoneKey("+998911234567"));
});

test("hidden/private/empty numbers can't be matched", () => {
  for (const f of ["", "-1", "-2", "unknown", null, undefined, "Private"]) {
    assert.equal(phoneKey(f), null, String(f));
  }
});

test("short service numbers keep all their digits", () => {
  assert.equal(phoneKey("1050"), null);
  assert.equal(phoneKey("12345"), "12345");
});
