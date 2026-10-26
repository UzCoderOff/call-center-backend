const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { normalizeUz, isExtension } = require("../src/services/pbx/numbers");
const { renderStaff, renderHints, renderGlobals, callerName } = require("../src/services/pbx/config");
const secrets = require("../src/services/pbx/secrets");
const { parseEvt, storedNumber, summarizeCall } = require("../src/services/pbx/ingest");
const { nextExt } = require("../src/services/pbx/provision");
const { parseMessage, formatMessage } = require("../src/services/pbx/ami");

test("Uzbek numbers in every common form go out as 9 digits", () => {
  for (const raw of ["+998 90 123 45 67", "998901234567", "901234567", "+998(90)123-45-67", "8 90 123 45 67"]) {
    assert.deepEqual(normalizeUz(raw), { national: "901234567", e164: "+998901234567" }, raw);
  }
});

test("abroad, emergency, short and nonsense numbers don't go out", () => {
  assert.equal(normalizeUz("+7 916 123 45 67").blocked, "international");
  assert.equal(normalizeUz("0079161234567").blocked, "international");
  for (const n of ["101", "102", "103", "104", "112"]) assert.equal(normalizeUz(n).blocked, "emergency", n);
  assert.equal(normalizeUz("1050").blocked, "short");
  assert.equal(normalizeUz("12345678901234").blocked, "invalid");
  assert.equal(normalizeUz("").blocked, "invalid");
});

test("phone IDs are three digits from 201 and never an emergency number", () => {
  assert.equal(isExtension("201"), true);
  assert.equal(isExtension("899"), true);
  for (const n of ["101", "112", "199", "900", "20", "2011", "abc"]) assert.equal(isExtension(n), false, n);
  assert.equal(nextExt(new Set()), "201");
  assert.equal(nextExt(new Set(["201", "202", "204"])), "203");
});

test("sign-in hashes are encrypted and come back the same", () => {
  const key = crypto.randomBytes(32);
  const ha1 = secrets.ha1("203", "ledger", "s3cret");
  assert.match(ha1, /^[0-9a-f]{32}$/);
  assert.equal(ha1, crypto.createHash("md5").update("203:ledger:s3cret").digest("hex"));
  const sealed = secrets.seal(ha1, key);
  assert.equal(sealed.includes(ha1), false);
  assert.equal(secrets.open(sealed, key), ha1);
  assert.throws(() => secrets.open(sealed, crypto.randomBytes(32)));
  assert.throws(() => secrets.keyFrom("short"));
  assert.notEqual(secrets.newSecret(), secrets.newSecret());
});

test("the staff file has one sign-in per phone and no plain secret", () => {
  const ha1 = "0123456789abcdef0123456789abcdef";
  const text = renderStaff(
    [
      { ext: "203", name: 'Ali "Boss" <x>; Valiyev', ha1, canCallOut: true },
      { ext: "204", name: "Vali", ha1, canCallOut: false },
      { ext: "101", name: "Not a phone ID", ha1, canCallOut: true },
      { ext: "205", name: "No hash", ha1: null, canCallOut: true },
    ],
    { realm: "ledger" }
  );
  assert.match(text, /\[203\]\(staff-endpoint\)\nauth=203\naors=203\ncontext=staff-out\ncallerid="Ali Boss x Valiyev" <203>/);
  assert.match(text, /\[204\]\(staff-endpoint\)[\s\S]*?context=staff-internal/);
  assert.match(text, /\[203\]\(staff-auth\)\nusername=203\nrealm=ledger\nmd5_cred=0123456789abcdef0123456789abcdef/);
  assert.equal(text.includes("[101]"), false);
  assert.equal(text.includes("[205]"), false);
  // A name can't start a comment or a new line in the file.
  assert.equal(callerName("a;b\nc"), "a b c");
});

test("hints combine the phone with Ledger's wake-up state", () => {
  assert.match(renderHints([{ ext: "203" }, { ext: "1" }]), /\[ledger-hints\]\nexten => 203,hint,PJSIP\/203&Custom:ledger203\n/);
  const g = renderGlobals({ LEDGER_HOOK: "http://127.0.0.1:4001/pbx", TRUNK_ENABLED: 0, "bad key": "x", COMPANY_NUMBER: "+99878;\n1" });
  assert.match(g, /LEDGER_HOOK=http:\/\/127\.0\.0\.1:4001\/pbx/);
  assert.match(g, /TRUNK_ENABLED=0/);
  assert.match(g, /COMPANY_NUMBER=\+998781\n/);
  assert.equal(g.includes("bad key"), false);
});

const exts = new Map([
  ["203", 11],
  ["204", 12],
]);
const ctx = (rotation = null) => ({ employeeByExt: exts, pickRotation: () => rotation });

test("an incoming call answered by the second operator is theirs", () => {
  const call = parseEvt("dir=in&num=998901234567&start=1000&end=1100&status=&rec=1000.1.wav");
  const rings = [parseEvt("ext=203&rs=1001&waited=0&status=NOANSWER&talk=0&kind=queue"), parseEvt("ext=204&rs=1021&waited=2&status=ANSWER&talk=60&kind=queue")];
  const s = summarizeCall(call, rings, ctx());
  assert.equal(s.employeeId, 12);
  assert.equal(s.callType, "incoming");
  assert.equal(s.missed, false);
  assert.equal(s.durationSeconds, 60);
  assert.equal(s.phoneNumber, "+998901234567");
  assert.equal(s.callTimestampMs, 1000000);
  assert.equal(s.detail.owner, "answered");
  assert.deepEqual(s.detail.rang.map((r) => r.ext), ["203", "204"]);
});

test("a missed call belongs to the operator whose turn it was", () => {
  const call = parseEvt("dir=in&num=901234567&start=1000&end=1050&status=TIMEOUT");
  const rings = [parseEvt("ext=204&rs=1021&status=NOANSWER"), parseEvt("ext=203&rs=1001&status=NOANSWER")];
  const s = summarizeCall(call, rings, ctx(99));
  assert.equal(s.employeeId, 11); // 203 was rung first
  assert.equal(s.callType, "missed");
  assert.equal(s.missed, true);
  assert.equal(s.durationSeconds, 0);
  assert.equal(s.detail.owner, "first_rung");
});

test("a missed call nobody could be rung for goes round the call center", () => {
  const s = summarizeCall(parseEvt("dir=in&num=901234567&start=1000&end=1003&status=JOINEMPTY"), [], ctx(12));
  assert.equal(s.employeeId, 12);
  assert.equal(s.detail.owner, "rotation");
  assert.equal(s.detail.reason, "nobody_free");
  assert.equal(summarizeCall(parseEvt("dir=in&num=1&start=1"), [], ctx(null)), null);
});

test("outgoing calls: answered, not answered, unknown phone ID", () => {
  const answered = summarizeCall(parseEvt("dir=out&ext=203&num=901234567&start=2000&end=2100&status=ANSWER&talk=42"), [], ctx());
  assert.equal(answered.employeeId, 11);
  assert.equal(answered.callType, "outgoing");
  assert.equal(answered.missed, false);
  assert.equal(answered.durationSeconds, 42);
  const notAnswered = summarizeCall(parseEvt("dir=out&ext=203&num=901234567&start=2000&status=NOANSWER&talk=0"), [], ctx());
  assert.equal(notAnswered.durationSeconds, 0); // follow-ups count it as an attempt
  assert.equal(summarizeCall(parseEvt("dir=out&ext=777&num=901234567&start=2000"), [], ctx()), null);
});

test("hidden caller numbers are stored empty (no call-back possible)", () => {
  assert.equal(storedNumber("anonymous"), "");
  assert.equal(storedNumber(""), "");
  assert.equal(storedNumber("+79161234567"), "+79161234567");
  const s = summarizeCall(parseEvt("dir=in&num=anonymous&start=1&end=2"), [], ctx(11));
  assert.equal(s.phoneNumber, "");
});

test("AMI messages: values can't break into another field", () => {
  assert.equal(formatMessage({ Action: "Setvar", Value: "a\r\nAction: Originate", Skip: undefined }), "Action: Setvar\r\nValue: a  Action: Originate\r\n\r\n");
  assert.deepEqual(parseMessage("Response: Success\r\nActionID: ledger-1\r\nMessage: Authentication accepted"), { Response: "Success", ActionID: "ledger-1", Message: "Authentication accepted" });
});

test("a calling client's name is safe to show on the phone and in the dialplan", () => {
  const { callerLabel } = require("../src/services/pbx/caller");
  assert.equal(callerLabel("Aliyev Sardor"), "Aliyev Sardor");
  assert.equal(callerLabel('Karimova "Dilnoza", OOO <Test>'), "Karimova Dilnoza OOO Test");
  assert.equal(callerLabel("${SHELL} a:b?c|d"), "SHELL a b c d");
  assert.equal(callerLabel("Qoʻchqorov Gʻayrat"), "Qoʻchqorov Gʻayrat");
  assert.equal(callerLabel("  "), "");
  assert.equal(callerLabel("x".repeat(60)).length, 40);
});

test("a phone that rang later in the same call isn't counted as off", () => {
  const { ringVerdicts } = require("../src/services/pbx/presence");
  const v = ringVerdicts([
    { ext: "203", status: "WAKE_TIMEOUT" },
    { ext: "204", status: "WAKE_TIMEOUT" },
    { ext: "203", status: "WAKE_TIMEOUT" },
    { ext: "203", status: "ANSWER" },
    { ext: "205", status: "BUSY" },
    { ext: "204", status: "CHANUNAVAIL" },
    { ext: "206", status: "WAKING" },
  ]);
  assert.deepEqual(Object.fromEntries(v), { 203: "worked", 204: "failed", 205: "worked" });
});

test("phone IDs never take the line's own numbers (500, the phone tests)", () => {
  const { nextExt, RESERVED } = require("../src/services/pbx/provision");
  const used = new Set();
  for (let n = 201; n < 500; n++) used.add(String(n));
  assert.equal(nextExt(used), "501");
  for (let n = 501; n < 600; n++) used.add(String(n));
  assert.equal(nextExt(used), "603");
  assert.ok(["500", "600", "601", "602"].every((x) => RESERVED.has(x)));
});

test("AMI fields can repeat (Originate's Variable)", () => {
  const msg = formatMessage({ Action: "Originate", Variable: ["A=1", "B=2"], Skip: undefined });
  assert.equal(msg, "Action: Originate\r\nVariable: A=1\r\nVariable: B=2\r\n\r\n");
});

test("night hours: both ends for Asterisk, past midnight too; off or nonsense is empty", () => {
  const { nightRange } = require("../src/services/pbx/settings");
  assert.equal(nightRange({ on: true, from: "22:00", to: "08:00" }), "22:00-07:59");
  assert.equal(nightRange({ on: true, from: "18:30", to: "00:00" }), "18:30-23:59");
  assert.equal(nightRange({ on: true, from: "00:00", to: "07:00" }), "00:00-06:59");
  assert.equal(nightRange({ on: false, from: "22:00", to: "08:00" }), "");
  assert.equal(nightRange({ on: true, from: "22:00", to: "22:00" }), "");
  assert.equal(nightRange({ on: true, from: "25:00", to: "08:00" }), "");
  assert.equal(nightRange(undefined), "");
});

test("the line's globals: each voice message only when recorded; night only with its message", () => {
  const { globalsFor } = require("../src/services/pbx/provision");
  const settings = { trunkEnabled: true, companyNumber: "+998781139001", night: { on: true, from: "22:00", to: "08:00" } };
  const none = globalsFor(settings, {});
  assert.equal(none.HAS_GREETING, 0);
  assert.equal(none.HAS_BUSY, 0);
  assert.equal(none.LINE_NIGHT, ""); // no night message: the line works as by day
  assert.equal(none.HAS_COORDINATOR, 0);
  const all = globalsFor(settings, { greeting: {}, coordinator: {}, coordinatorBusy: {}, busy: {}, night: {}, thanks: {} });
  assert.equal(all.HAS_GREETING, 1);
  assert.equal(all.HAS_COORDINATOR, 1);
  assert.equal(all.HAS_COORDINATOR_BUSY, 1);
  assert.equal(all.HAS_BUSY, 1);
  assert.equal(all.HAS_THANKS, 1);
  assert.equal(all.LINE_NIGHT, "22:00-07:59");
  assert.match(renderGlobals(all), /\nLINE_NIGHT=22:00-07:59\n/);
  assert.equal(globalsFor({ ...settings, night: { ...settings.night, on: false } }, { night: {} }).LINE_NIGHT, "");
});

test("a call outside working hours is a missed call for the call center, said to be at night", () => {
  const s = summarizeCall(parseEvt("dir=in&num=901234567&start=1000&end=1030&status=&vm=night"), [], ctx(12));
  assert.equal(s.missed, true);
  assert.equal(s.employeeId, 12);
  assert.equal(s.detail.owner, "rotation");
  assert.equal(s.detail.reason, "night");
  const busy = summarizeCall(parseEvt("dir=in&num=901234567&start=1000&end=1200&status=TIMEOUT&vm=busy"), [parseEvt("ext=203&rs=1001&status=NOANSWER")], ctx(12));
  assert.equal(busy.detail.reason, "not_answered");
  assert.equal(busy.employeeId, 11);
});
