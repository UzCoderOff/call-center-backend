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
  assert.deepEqual(s.detail.direct, { ext: "205", employeeId: 15, answered: true, status: "ANSWER", coordinator: true });
  assert.deepEqual(missedBy(s), []);
});

// --- whose phone rang, and who took it (2026-10-27) -----------------------
const { ringNotices } = require("../src/services/pbx/ingest");

test("an operator rung first for their own caller isn't sent to call back when a colleague took it — they're told who did", () => {
  const rings = [parseEvt("ext=206&rs=1001&status=NOANSWER&kind=direct&note=mine%3Alast"), parseEvt("ext=203&rs=1032&status=ANSWER&talk=50&kind=queue&note=missedop%3AVali")];
  const s = summarizeCall(parseEvt("dir=in&num=901234567&start=1000&end=1100"), rings, ctx);
  assert.equal(s.employeeId, 11);
  assert.equal(s.detail.direct.coordinator, false);
  assert.equal(s.detail.rang[0].note, "mine:last");
  assert.deepEqual(missedBy(s), []);
  assert.deepEqual(ringNotices(s), [{ employeeId: 16, answeredBy: 11, owner: null }]);
});

test("a coordinator who missed their client is reminded, not told it's handled", () => {
  const rings = [parseEvt("ext=205&rs=1001&status=NOANSWER&kind=direct&note=direct"), parseEvt("ext=203&rs=1032&status=ANSWER&talk=50&kind=queue")];
  const s = summarizeCall(parseEvt("dir=in&num=901234567&start=1000&end=1100"), rings, ctx);
  assert.deepEqual(
    missedBy(s).map((m) => m.employeeId),
    [15]
  );
  assert.deepEqual(ringNotices(s), []);
});

test("everyone whose phone rang hears once that someone else answered", () => {
  const rings = [
    parseEvt("ext=206&rs=1001&status=NOANSWER&kind=queue"),
    parseEvt("ext=205&rs=1033&status=NOANSWER&kind=queue"),
    parseEvt("ext=206&rs=1065&status=NOANSWER&kind=queue"),
    parseEvt("ext=203&rs=1097&status=ANSWER&talk=20&kind=queue"),
  ];
  const s = summarizeCall(parseEvt("dir=in&num=901234567&start=1000&end=1200"), rings, ctx);
  assert.deepEqual(ringNotices(s), [
    { employeeId: 16, answeredBy: 11, owner: null },
    { employeeId: 15, answeredBy: 11, owner: null },
  ]);
});

test("nobody answered: each phone that rang hears it, and whose list it's on", () => {
  const rings = [parseEvt("ext=206&rs=1001&status=NOANSWER&kind=queue"), parseEvt("ext=203&rs=1033&status=NOANSWER&kind=queue")];
  const s = summarizeCall(parseEvt("dir=in&num=901234567&start=1000&end=1070&status=TIMEOUT"), rings, ctx);
  assert.equal(s.employeeId, 16);
  assert.deepEqual(ringNotices(s), [
    { employeeId: 16, answeredBy: null, owner: 16 },
    { employeeId: 11, answeredBy: null, owner: 16 },
  ]);
  // At night nobody is rung: nobody is told.
  assert.deepEqual(ringNotices(summarizeCall(parseEvt("dir=in&num=901234567&start=1000&end=1070&vm=night"), [], { ...ctx, pickRotation: () => 11 })), []);
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

// --- Ledger's release notes in the firm's Telegram groups ----------------
test("a group gets the whole release, and only groups count as groups", () => {
  const { groupMessage } = require("../src/services/news");
  const { isGroup } = require("../src/services/telegram/groups");
  const text = groupMessage({ boss: ["<b>A</b>: one", "two"], staff: [] });
  assert.equal(text, "🆕 <b>Ledger yangilandi</b>\n• <b>A</b>: one\n• two");
  assert.equal(groupMessage({ boss: [], staff: [] }), null);
  assert.equal(isGroup({ type: "supergroup" }), true);
  assert.equal(isGroup({ type: "group" }), true);
  assert.equal(isGroup({ type: "private" }), false);
});

// --- calls going on right now (live.js) -----------------------------------
const { liveCalls, seconds, canHearCalls } = require("../src/services/pbx/live");

test("calls going on: who's talking, who's ringing, who's waiting in line", () => {
  const ch = (Channel, more) => ({ Channel, ChannelState: "6", BridgeId: "", Duration: "00:00:30", ...more });
  const talking = [
    ch("PJSIP/skyline-00000001", { Context: "company-line", Application: "Queue", Uniqueid: "1.1", Linkedid: "1.1", BridgeId: "b1", CallerIDNum: "+998901234567", Duration: "00:01:05" }),
    ch("Local/203@ring-person-00000001;1", { Context: "ring-person", Application: "AppQueue", Uniqueid: "1.2", Linkedid: "1.1", BridgeId: "b1" }),
    ch("Local/203@ring-person-00000001;2", { Context: "ring-person", Application: "Dial", Uniqueid: "1.3", Linkedid: "1.1", BridgeId: "b2" }),
    ch("PJSIP/203-00000002", { Context: "ring-person", Application: "AppDial", Uniqueid: "1.4", Linkedid: "1.1", BridgeId: "b2" }),
  ];
  const waiting = [ch("PJSIP/skyline-00000003", { Context: "company-line", Application: "Queue", Uniqueid: "2.1", Linkedid: "2.1", CallerIDNum: "+998911111111", Duration: "00:00:10" })];
  const ringing = [
    ch("PJSIP/skyline-00000005", { Context: "company-line", Application: "Dial", Uniqueid: "3.1", Linkedid: "3.1", CallerIDNum: "+998922222222", Duration: "00:00:05" }),
    ch("PJSIP/205-00000006", { Context: "ring-person", Application: "AppDial", Uniqueid: "3.2", Linkedid: "3.1", ChannelState: "5" }),
  ];
  const colleagues = [
    ch("PJSIP/204-00000007", { Context: "colleague", Application: "Dial", Uniqueid: "4.1", Linkedid: "4.1", BridgeId: "x" }),
    ch("PJSIP/206-00000008", { Context: "ring-person", Application: "AppDial", Uniqueid: "4.2", Linkedid: "4.1", BridgeId: "x" }),
  ];
  const out = [
    ch("PJSIP/207-00000009", { Context: "outbound", Application: "Dial", Exten: "933333333", Uniqueid: "5.1", Linkedid: "5.1", BridgeId: "y", Duration: "00:00:20" }),
    ch("PJSIP/skyline-0000000a", { Context: "from-trunk", Application: "AppDial", Uniqueid: "5.2", Linkedid: "5.1", BridgeId: "y" }),
  ];
  const calls = liveCalls([...talking, ...waiting, ...ringing, ...colleagues, ...out]);
  assert.deepEqual(
    calls.map((c) => [c.id, c.direction, c.number, c.state, c.seconds, c.exts.map((e) => `${e.ext}:${e.state}`).join()]),
    [
      ["1.1", "in", "+998901234567", "talking", 65, "203:talking"],
      ["5.1", "out", "+998933333333", "talking", 20, "207:talking"],
      ["2.1", "in", "+998911111111", "waiting", 10, ""],
      ["3.1", "in", "+998922222222", "ringing", 5, "205:ringing"],
    ]
  );
  assert.deepEqual(calls[0].recordings, ["1.1"]);
});

test("only the developer and people switched on hear calls", () => {
  assert.equal(seconds("01:02:03"), 3723);
  assert.equal(canHearCalls({ role: "DEVELOPER", active: true }), true);
  assert.equal(canHearCalls({ role: "BOSS", active: true, hearsCalls: true }), true);
  assert.equal(canHearCalls({ role: "BOSS", active: true, hearsCalls: false }), false);
  assert.equal(canHearCalls({ role: "DEVELOPER", active: false }), false);
  assert.equal(canHearCalls(null), false);
});
