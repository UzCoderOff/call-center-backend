const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused-secret-for-tests";
const w = require("../src/services/workdays");
const { scheduleOf, normalizeSchedule } = require("../src/services/installments");
const { buildWorkbook } = require("../src/lib/xlsx");

const office = { workDays: "123456", holidaysOff: true };
const callCenter = { workDays: "1234567", holidaysOff: false };
const holidays = new Map([["2026-10-01", "Oʻqituvchi va murabbiylar kuni"]]);

test("office staff: Sundays and confirmed holidays off; call center: every day", () => {
  // 2026-10-01 is a Thursday (a holiday), 2026-10-04 a Sunday.
  assert.deepEqual(w.offReason("2026-10-01", office, holidays), { kind: "holiday", name: "Oʻqituvchi va murabbiylar kuni" });
  assert.deepEqual(w.offReason("2026-10-04", office, holidays), { kind: "weekly" });
  assert.equal(w.offReason("2026-10-02", office, holidays), null);
  assert.equal(w.offReason("2026-10-01", callCenter, holidays), null);
  assert.equal(w.offReason("2026-10-04", callCenter, holidays), null);
});

test("approved days away count; working remotely doesn't", () => {
  const away = [
    { from: "2026-10-05", to: "2026-10-07", kind: "vacation" },
    { from: "2026-10-08", to: "2026-10-08", kind: "remote" },
  ];
  assert.deepEqual(w.offReason("2026-10-06", callCenter, holidays, away), { kind: "vacation" });
  assert.equal(w.offReason("2026-10-08", office, holidays, away), null);
});

test("work patterns are cleaned up; nonsense is refused", () => {
  assert.equal(w.normalizePattern("654321"), "123456");
  assert.equal(w.normalizePattern("1,2,3,3,7"), "1237");
  assert.equal(w.normalizePattern("890"), null);
  assert.equal(w.normalizePattern(123), null);
  assert.equal(w.checkAbsence({ from: "2026-10-05", to: "2026-10-01", kind: "sick" }), "from is after to");
  assert.equal(w.checkAbsence({ from: "2026-10-01", to: "2026-10-02", kind: "party" }), "invalid kind");
  assert.equal(w.checkAbsence({ from: "2026-10-01", to: "2026-10-02", kind: "sick" }), null);
  assert.ok(w.isBuiltinDate("2027-03-21") && !w.isBuiltinDate("2027-03-22"));
});

test("a payment schedule: payments cover the installments in date order", () => {
  const plan = [
    { id: 1, dueDate: "2026-09-10", amount: 3000000 },
    { id: 2, dueDate: "2026-10-10", amount: 3000000 },
    { id: 3, dueDate: "2026-11-10", amount: 4000000 },
  ];
  const payments = [
    { amount: 450000, kind: "consultation" }, // not towards the contract
    { amount: 3000000, kind: "contract" },
    { amount: 1000000, kind: "contract" },
  ];
  const s = scheduleOf(plan, payments, "2026-10-15");
  assert.deepEqual(s.items.map((i) => [i.status, i.paid, i.left]), [
    ["paid", 3000000, 0],
    ["overdue", 1000000, 2000000],
    ["upcoming", 0, 4000000],
  ]);
  assert.equal(s.overdue, 2000000);
  assert.equal(s.overdueSince, "2026-10-10");
  assert.deepEqual(s.next, { dueDate: "2026-11-10", left: 4000000 });
  assert.equal(scheduleOf(plan, [{ amount: 11000000, kind: "contract" }], "2026-10-15").ahead, 1000000);
  assert.throws(() => normalizeSchedule([{ dueDate: "2026-13-01", amount: 5 }]), /invalid date/);
  assert.throws(() => normalizeSchedule([{ dueDate: "2026-10-01", amount: 0 }]), /invalid amount/);
});

test("an Excel workbook with several sheets", () => {
  const { unzipSync, strFromU8 } = require("fflate");
  const files = unzipSync(new Uint8Array(buildWorkbook([{ name: "Umumiy", rows: [["A"], [1]] }, { name: "Umumiy", rows: [["B"]] }])));
  assert.ok(files["xl/worksheets/sheet2.xml"]);
  assert.match(strFromU8(files["xl/workbook.xml"]), /name="Umumiy".*name="Umumiy 2"/);
});

test("what a person is measured on: their report form's numbers, added up", () => {
  const m = require("../src/services/performanceMetrics");
  const form = {
    id: 3,
    name: "Hujjatlar",
    fields: [
      { id: "docs", type: "number", label: "Hujjatlar soni" },
      { id: "notes", type: "textarea", label: "Izoh" },
      { id: "svc", type: "table", label: "Xizmatlar", columns: [{ id: "kind", type: "select", label: "Xizmat" }, { id: "people", type: "number", label: "Mijozlar" }, { id: "cash", type: "money", label: "Tushum" }] },
    ],
  };
  assert.deepEqual(m.formMeasures(form).map((x) => [x.key, x.label, x.unit]), [
    ["report:3:docs", "Hujjatlar soni", "count"],
    ["report:3:svc:people", "Xizmatlar → Mijozlar", "count"],
    ["report:3:svc:cash", "Xizmatlar → Tushum", "money"],
  ]);
  const reports = [
    { date: "2026-10-01", templateId: 3, fields: form.fields, answers: { docs: 4, svc: [{ kind: "Notarius", people: 2, cash: 100000 }, { kind: "Tarjima", people: 1, cash: 50000 }] } },
    { date: "2026-10-02", templateId: 3, fields: form.fields, answers: { docs: 6, svc: [{ kind: "Notarius", people: 3, cash: 150000 }] } },
  ];
  const v = m.reportValues(reports);
  assert.equal(v.get("report:3:docs").total, 10);
  assert.equal(v.get("report:3:svc:people").total, 6);
  assert.deepEqual([...v.get("report:3:svc:people").groups], [["Notarius", 5], ["Tarjima", 1]]);
  assert.equal(v.get("report:3:svc:cash").byDate.get("2026-10-02"), 150000);
  assert.deepEqual(m.parseKey("report:3:svc:cash"), { templateId: 3, fieldId: "svc", columnId: "cash" });
  assert.deepEqual(m.parseKey("contracts"), { builtin: "contracts" });
  assert.equal(m.parseKey("report:x:y"), null);
});

test("targets: a person's own, latest from that month on; the position's as the default", async () => {
  const m = require("../src/services/performanceMetrics");
  const rows = [
    { employeeId: 1, metric: "report:3:docs", amount: 150, fromMonth: "2026-11" },
    { employeeId: 1, metric: "report:3:docs", amount: 120, fromMonth: "2026-10" },
    { employeeId: 1, metric: "contracts", amount: 0, fromMonth: "2026-10" }, // "no target" beats the position's
  ];
  const db = { target: { findMany: async ({ where }) => rows.filter((r) => r.fromMonth <= where.fromMonth.lte).sort((a, b) => (a.fromMonth < b.fromMonth ? 1 : -1)) } };
  const people = [{ id: 1, position: { targetConsultations: 60, targetContracts: 30 } }];
  const oct = (await m.targetsFor(people, "2026-10", db)).get(1);
  assert.deepEqual([...oct].sort(), [["consultations", 60], ["report:3:docs", 120]]);
  assert.equal((await m.targetsFor(people, "2026-12", db)).get(1).get("report:3:docs"), 150);
});
