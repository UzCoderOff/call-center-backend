const test = require("node:test");
const assert = require("node:assert/strict");
const { findClientLeg, reachabilityOf, peopleOf } = require("../src/services/pbx/transfer");
const { parseEvt, summarizeCall } = require("../src/services/pbx/ingest");

// What CoreShowChannels lists while a client (on the outside line) talks to
// operator 203 through the call-center line: the client's channel in Queue,
// the queue's Local channel pair, and the operator's phone.
const queueCall = [
  { Channel: "PJSIP/skyline-00000001", ChannelState: "6", Context: "company-line", Application: "Queue", Uniqueid: "100.1", Linkedid: "100.1", BridgeId: "b1" },
  { Channel: "Local/203@ring-person-00000001;1", ChannelState: "6", Context: "ring-person", Application: "AppQueue", Uniqueid: "100.2", Linkedid: "100.1", BridgeId: "b1" },
  { Channel: "Local/203@ring-person-00000001;2", ChannelState: "6", Context: "ring-person", Application: "Dial", Uniqueid: "100.3", Linkedid: "100.1", BridgeId: "b2" },
  { Channel: "PJSIP/203-00000002", ChannelState: "6", Context: "ring-person", Application: "AppDial", Uniqueid: "100.4", Linkedid: "100.1", BridgeId: "b2" },
];

test("the client's side of an operator's call is found through the queue", () => {
  assert.equal(findClientLeg(queueCall, "203").Channel, "PJSIP/skyline-00000001");
});

test("someone else's call, a phone still ringing, or no call: nothing to pass on", () => {
  assert.equal(findClientLeg(queueCall, "204"), null);
  const ringing = queueCall.map((c) => (c.Channel.startsWith("PJSIP/203") ? { ...c, ChannelState: "5", BridgeId: "" } : c));
  assert.equal(findClientLeg(ringing, "203"), null);
  assert.equal(findClientLeg([], "203"), null);
});

test("a call already passed on can be passed on again by whoever took it", () => {
  const passed = [
    { Channel: "PJSIP/skyline-00000001", ChannelState: "6", Context: "ledger-transfer", Application: "Dial", Uniqueid: "100.1", Linkedid: "100.1", BridgeId: "b3" },
    { Channel: "Local/205@ring-person-00000002;1", ChannelState: "6", Context: "ring-person", Application: "AppDial", Uniqueid: "100.5", Linkedid: "100.1", BridgeId: "b3" },
    { Channel: "Local/205@ring-person-00000002;2", ChannelState: "6", Context: "ring-person", Application: "Dial", Uniqueid: "100.6", Linkedid: "100.1", BridgeId: "b4" },
    { Channel: "PJSIP/205-00000003", ChannelState: "6", Context: "ring-person", Application: "AppDial", Uniqueid: "100.7", Linkedid: "100.1", BridgeId: "b4" },
  ];
  assert.equal(findClientLeg(passed, "205").Channel, "PJSIP/skyline-00000001");
});

test("a call between colleagues or a call out isn't a client call to pass on", () => {
  const colleague = [
    { Channel: "PJSIP/204-00000001", ChannelState: "6", Context: "colleague", Application: "Dial", Uniqueid: "1", Linkedid: "1", BridgeId: "x" },
    { Channel: "PJSIP/203-00000002", ChannelState: "6", Context: "ring-person", Application: "AppDial", Uniqueid: "2", Linkedid: "1", BridgeId: "x" },
  ];
  assert.equal(findClientLeg(colleague, "203"), null);
  const out = [
    { Channel: "PJSIP/203-00000001", ChannelState: "6", Context: "outbound", Application: "Dial", Uniqueid: "1", Linkedid: "1", BridgeId: "x" },
    { Channel: "PJSIP/skyline-00000002", ChannelState: "6", Context: "from-trunk", Application: "AppDial", Uniqueid: "2", Linkedid: "1", BridgeId: "x" },
  ];
  assert.equal(findClientLeg(out, "203"), null);
});

test("free, busy or off, from the phones' hints", () => {
  const map = reachabilityOf([
    { Event: "ExtensionStatus", Exten: "203", Context: "ledger-hints", Status: "0" },
    { Event: "ExtensionStatus", Exten: "204", Context: "ledger-hints", Status: "1" },
    { Event: "ExtensionStatus", Exten: "205", Context: "ledger-hints", Status: "4" },
    { Event: "ExtensionStatus", Exten: "206", Context: "ledger-hints", Status: "8" },
    { Event: "ExtensionStatus", Exten: "500", Context: "staff-out", Status: "0" },
  ]);
  assert.deepEqual(Object.fromEntries(map), { 203: "free", 204: "busy", 205: "off", 206: "busy" });
});

test("who works on a client: coordinator first, then lawyers, then the operator before a contract", () => {
  const lines = new Map([
    [7, { ext: "205", status: "free" }],
    [9, { ext: "207", status: "busy" }],
  ]);
  const client = {
    cases: [
      { status: "contract", operator: { id: 3, name: "Op" }, coordinator: { id: 7, name: "Aziza" }, lawyerAccount: { employee: { id: 9, name: "Advokat A" } }, extraLawyers: [{ user: { employee: null } }] },
      { status: "consultation", operator: { id: 4, name: "Dilnoza" }, coordinator: { id: 7, name: "Aziza" }, lawyerAccount: null, extraLawyers: [] },
    ],
  };
  assert.deepEqual(peopleOf(client, lines), [
    { employeeId: 7, name: "Aziza", role: "Koordinator", ext: "205", status: "free" },
    { employeeId: 9, name: "Advokat A", role: "Advokat", ext: "207", status: "busy" },
    { employeeId: 4, name: "Dilnoza", role: "Operator", ext: null, status: "off" },
  ]);
});

const exts = new Map([
  ["203", 11],
  ["205", 15],
  ["206", 16],
]);
const ctx = { employeeByExt: exts, pickRotation: () => null };

test("a call passed on stays the answering operator's, with whom it went to", () => {
  const call = parseEvt("dir=in&num=998901234567&start=1000&end=1300&rec=1000.1.wav");
  const rings = [
    parseEvt("ext=203&rs=1001&status=ANSWER&talk=40&kind=queue"),
    parseEvt("ext=205&rs=1045&waited=3&status=ANSWER&talk=200&kind=transfer"),
    parseEvt("ext=206&rs=1250&status=NOANSWER&talk=0&kind=transfer"),
  ];
  const s = summarizeCall(call, rings, ctx);
  assert.equal(s.employeeId, 11);
  assert.equal(s.callType, "incoming");
  assert.equal(s.durationSeconds, 40);
  assert.deepEqual(s.detail.transfers, [
    { ext: "205", employeeId: 15, fromEmployeeId: 11, answered: true, status: "ANSWER", talkSec: 200 },
    { ext: "206", employeeId: 16, fromEmployeeId: 15, answered: false, status: "NOANSWER", talkSec: 0 },
  ]);
});

test("a call that came back to the operator counts all their talk", () => {
  const call = parseEvt("dir=in&num=998901234567&start=1000&end=1200");
  const rings = [
    parseEvt("ext=203&rs=1001&status=ANSWER&talk=18&kind=queue"),
    parseEvt("ext=206&rs=1020&status=NOANSWER&talk=0&kind=transfer"),
    parseEvt("ext=203&rs=1050&status=ANSWER&talk=43&kind=transfer_back"),
  ];
  const s = summarizeCall(call, rings, ctx);
  assert.equal(s.employeeId, 11);
  assert.equal(s.durationSeconds, 61);
  assert.equal(s.detail.transfers.length, 1);
});

test("an ordinary call has no transfers on it", () => {
  const s = summarizeCall(parseEvt("dir=in&num=901234567&start=1000&end=1060"), [parseEvt("ext=203&rs=1001&status=ANSWER&talk=50&kind=queue")], ctx);
  assert.equal(s.detail.transfers, undefined);
});

// --- clients in work go straight to their coordinator (route.js) ---------
const { coordinatorFor } = require("../src/services/pbx/route");
const { missedBy } = require("../src/services/pbx/ingest");

test("a client in work goes to the coordinator of their newest contract case who's on the line", () => {
  const coord = (id, name, more = {}) => ({ id, name, active: true, pbxCalling: true, ...more });
  const client = {
    cases: [
      { status: "contract", updatedAt: "2026-10-01", coordinator: coord(7, "Aziza") },
      { status: "contract", updatedAt: "2026-10-20", coordinator: coord(8, "Bobur", { pbxCalling: false }) },
      { status: "consultation", updatedAt: "2026-10-23", coordinator: coord(9, "Dilshod") },
      { status: "done", updatedAt: "2026-10-22", coordinator: coord(10, "Eldor") },
    ],
  };
  const lines = new Map([
    [7, "205"],
    [8, "206"],
    [9, "207"],
    [10, "208"],
  ]);
  // Bobur's case is newer, but he isn't on the line; a consultation or a
  // finished case doesn't count.
  assert.deepEqual(coordinatorFor(client, lines), { ext: "205", name: "Aziza" });
  assert.equal(coordinatorFor(client, new Map([[8, "206"]])), null);
  assert.equal(coordinatorFor({ cases: [{ status: "consultation", updatedAt: "2026-10-01", coordinator: coord(7, "Aziza") }] }, lines), null);
  assert.equal(coordinatorFor(null, lines), null);
});

test("the coordinator's side of a client call sent straight to them can be passed on", () => {
  const direct = [
    { Channel: "PJSIP/skyline-00000001", ChannelState: "6", Context: "company-line", Application: "Dial", Uniqueid: "1", Linkedid: "1", BridgeId: "b1" },
    { Channel: "Local/205@ring-person-00000001;1", ChannelState: "6", Context: "ring-person", Application: "AppDial", Uniqueid: "2", Linkedid: "1", BridgeId: "b1" },
    { Channel: "Local/205@ring-person-00000001;2", ChannelState: "6", Context: "ring-person", Application: "Dial", Uniqueid: "3", Linkedid: "1", BridgeId: "b2" },
    { Channel: "PJSIP/205-00000002", ChannelState: "6", Context: "ring-person", Application: "AppDial", Uniqueid: "4", Linkedid: "1", BridgeId: "b2" },
  ];
  assert.equal(findClientLeg(direct, "205").Channel, "PJSIP/skyline-00000001");
});

test("a client's call the coordinator answered is the coordinator's", () => {
  const s = summarizeCall(parseEvt("dir=in&num=901234567&start=1000&end=1100"), [parseEvt("ext=205&rs=1001&status=ANSWER&talk=80&kind=direct")], ctx);
  assert.equal(s.employeeId, 15);
  assert.equal(s.durationSeconds, 80);
  assert.deepEqual(s.detail.direct, { ext: "205", employeeId: 15, answered: true, status: "ANSWER" });
  assert.deepEqual(missedBy(s), []);
});

test("the coordinator didn't answer, an operator did: the operator's call, a reminder for the coordinator", () => {
  const rings = [parseEvt("ext=205&rs=1001&status=NOANSWER&kind=direct"), parseEvt("ext=203&rs=1026&status=ANSWER&talk=40&kind=queue")];
  const s = summarizeCall(parseEvt("dir=in&num=901234567&start=1000&end=1100"), rings, ctx);
  assert.equal(s.employeeId, 11);
  assert.equal(s.detail.direct.answered, false);
  const who = missedBy(s);
  assert.deepEqual(
    who.map((w) => [w.employeeId, w.fromEmployeeId]),
    [[15, 11]]
  );
  assert.match(who[0].notes, /Mijozingiz/);
});

test("nobody answered a client in work: a missed call for their coordinator, no extra reminder", () => {
  const rings = [parseEvt("ext=205&rs=1001&status=NOANSWER&kind=direct"), parseEvt("ext=203&rs=1026&status=NOANSWER&kind=queue")];
  const s = summarizeCall(parseEvt("dir=in&num=901234567&start=1000&end=1100&status=TIMEOUT"), rings, ctx);
  assert.equal(s.missed, true);
  assert.equal(s.employeeId, 15);
  assert.deepEqual(missedBy(s), []);
});

test("a colleague who didn't answer a call passed to them is reminded, once", () => {
  const rings = [
    parseEvt("ext=203&rs=1001&status=ANSWER&talk=30&kind=queue"),
    parseEvt("ext=206&rs=1040&status=NOANSWER&kind=transfer"),
    parseEvt("ext=203&rs=1075&status=ANSWER&talk=20&kind=transfer_back"),
    parseEvt("ext=206&rs=1100&status=NOANSWER&kind=transfer"),
  ];
  const s = summarizeCall(parseEvt("dir=in&num=901234567&start=1000&end=1200"), rings, ctx);
  assert.deepEqual(
    missedBy(s).map((w) => w.employeeId),
    [16]
  );
});
