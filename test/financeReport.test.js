const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused-secret-for-tests";
const { reportMoney, groupEntries } = require("../src/services/reportMoney");
const { buildFinance } = require("../src/services/financeReport");
const { pairFees } = require("../src/services/consultationFee");
const { normalizeFields } = require("../src/services/reportFields");

const table = {
  id: "t1",
  label: "Xizmatlar",
  type: "table",
  columns: [
    { id: "svc", label: "Xizmat", type: "select", options: ["Tarjima", "Notarius"] },
    { id: "sum", label: "Summa", type: "money" },
    { id: "taxi", label: "Taksi", type: "money" },
  ],
};
const cash = { id: "m1", label: "Naqd olindi", type: "money" };
const fee = { id: "m2", label: "Konsultatsiya", type: "money" };

test("money questions can be marked income or expense; anything else is dropped", () => {
  const fields = normalizeFields([
    { ...cash, finance: "income" },
    { ...fee, finance: "bogus" },
    { id: "n1", label: "Nechta", type: "number", finance: "income" },
    { ...table, columns: [{ ...table.columns[0] }, { ...table.columns[1], finance: "income" }, { ...table.columns[2], finance: "expense" }] },
  ]);
  assert.equal(fields[0].finance, "income");
  assert.equal(fields[1].finance, undefined);
  assert.equal(fields[2].finance, undefined); // not a money question
  assert.deepEqual(fields[3].columns.map((c) => c.finance), [undefined, "income", "expense"]);
});

test("report money counts only marked questions, as the form is set NOW", () => {
  // The reports were sent before anything was marked (their copies say nothing).
  const reports = [
    {
      id: 1,
      date: "2026-09-10",
      templateId: 5,
      employeeId: 3,
      employee: { name: "Nodira" },
      fields: [cash, fee, table],
      answers: { m1: 200000, m2: 450000, t1: [{ svc: "Tarjima", sum: 150000, taxi: 20000 }, { svc: "Notarius", sum: 300000 }] },
    },
    { id: 2, date: "2026-09-11", templateId: 5, employeeId: 4, employee: { name: "Sardor" }, fields: [cash, table], answers: { m1: 50000, t1: [{ svc: "Tarjima", sum: 100000 }] } },
  ];
  const templates = [
    {
      id: 5,
      name: "Hujjatlar",
      fields: [{ ...cash, label: "Naqd pul", finance: "income" }, fee, { ...table, columns: [table.columns[0], { ...table.columns[1], finance: "income" }, { ...table.columns[2], finance: "expense" }] }],
    },
  ];
  const { entries, unclassified } = reportMoney(reports, templates);
  const income = entries.filter((e) => e.kind === "income");
  const expense = entries.filter((e) => e.kind === "expense");
  assert.equal(income.reduce((s, e) => s + e.amount, 0), 200000 + 150000 + 300000 + 50000 + 100000);
  assert.equal(expense.reduce((s, e) => s + e.amount, 0), 20000);
  // The unmarked consultation question isn't counted, but it's listed.
  // (and whose it is, for that person's page in Natijalar)
  assert.deepEqual(unclassified, [{ form: "Hujjatlar", label: "Konsultatsiya", column: null, amount: 450000, count: 1, byEmployee: { 3: 450000 } }]);
  // Grouped by question and service, with who wrote it; today's label.
  const items = groupEntries(income);
  assert.deepEqual(items.find((i) => i.service === "Tarjima"), { form: "Hujjatlar", label: "Xizmatlar", column: "Summa", service: "Tarjima", amount: 250000, count: 2, people: ["Nodira", "Sardor"] });
  assert.equal(items.find((i) => i.column === null).label, "Naqd pul");
});

test("a fee recorded on the client's page goes to the nearest unpaid appointment", () => {
  const pairs = pairFees(
    [
      { id: 1, date: "2026-09-10", appointmentId: null },
      { id: 2, date: "2026-09-01", appointmentId: 7, appointmentStatus: "cancelled" }, // its visit was cancelled
      { id: 3, date: "2026-01-01", appointmentId: null }, // too long ago
    ],
    [
      { id: 7, date: "2026-09-02", status: "cancelled", paid: true },
      { id: 8, date: "2026-09-12", status: "booked", paid: false },
      { id: 9, date: "2026-09-03", status: "attended", paid: false },
      { id: 10, date: "2026-09-11", status: "booked", paid: true },
    ]
  );
  assert.deepEqual(pairs, [
    { paymentId: 1, appointmentId: 8 },
    { paymentId: 2, appointmentId: 9 },
  ]);
});

test("the Moliya month: income by source, consultations, contracts, debts", () => {
  const names = new Map([[20, "Rashidova Madina"]]);
  const reportEntries = [
    { reportId: 9, date: "2026-09-06", person: "Nodira", templateId: 5, fieldId: "m1", label: "Tarjima", column: null, service: null, amount: 250000, kind: "income" },
    { reportId: 9, date: "2026-09-06", person: "Nodira", templateId: 5, fieldId: "m3", label: "Taksi", column: null, service: null, amount: 30000, kind: "expense" },
  ];
  const data = buildFinance({
    month: "2026-09",
    today: "2026-09-30",
    fee: 450000,
    names,
    payments: [
      { id: 1, date: "2026-09-05", amount: 450000, kind: "consultation", method: "cash", client: { id: 1, name: "A" }, case: null, recordedBy: "Dilnoza", appointment: { format: "online", ownerId: 20 } },
      { id: 2, date: "2026-09-06", amount: 3000000, kind: "contract", method: "card", client: { id: 1, name: "A" }, case: { id: 11, lawyerId: 20, lawyer: "Rashidova", contractDate: "2026-09-06" }, recordedBy: "Rahbar", appointment: null },
      { id: 3, date: "2026-09-07", amount: 1000000, kind: "contract", method: "cash", client: { id: 2, name: "B" }, case: { id: 12, lawyerId: 20, lawyer: "Rashidova", contractDate: "2026-05-01" }, recordedBy: "Rahbar", appointment: null },
    ],
    trendPayments: [
      { date: "2026-08-10", amount: 900000, kind: "consultation" },
      { date: "2026-09-05", amount: 450000, kind: "consultation" },
      { date: "2026-09-06", amount: 3000000, kind: "contract" },
      { date: "2026-09-07", amount: 1000000, kind: "contract" },
    ],
    cases: [
      { id: 11, contractAmount: 10000000, contractDate: "2026-09-06", lawyerId: 20, lawyer: "Rashidova", matter: "Meros", client: { id: 1, name: "A" }, payments: [{ amount: 3000000, date: "2026-09-06" }] },
      { id: 12, contractAmount: 5000000, contractDate: "2026-05-01", lawyerId: 20, lawyer: "Rashidova", matter: null, client: { id: 2, name: "B" }, payments: [{ amount: 1000000, date: "2026-09-07" }] },
    ],
    appointments: [
      { id: 101, date: "2026-09-05", start: 600, status: "attended", format: "online", clientId: 1, clientName: "A", ownerId: 20, calendarName: "Advokat Rashidova", paid: { amount: 450000 } },
      { id: 102, date: "2026-09-08", start: 600, status: "attended", format: "office", clientId: 3, clientName: "C", ownerId: 20, calendarName: "Advokat Rashidova", paid: null },
      { id: 103, date: "2026-09-09", start: 600, status: "no_show", format: "office", clientId: 4, clientName: "D", ownerId: 20, calendarName: "Advokat Rashidova", paid: null },
      { id: 104, date: "2026-09-10", start: 600, status: "cancelled", format: "office", clientId: 5, clientName: "E", ownerId: 20, calendarName: "Advokat Rashidova", paid: null },
    ],
    contractDates: new Map([[1, ["2026-09-06"]]]),
    report: { entries: reportEntries, unclassified: [] },
    reportTrend: reportEntries,
  });

  assert.equal(data.summary.clientIncome, 4450000);
  assert.equal(data.summary.reportIncome, 250000);
  assert.equal(data.summary.income, 4700000);
  assert.equal(data.summary.expenses, 30000);
  assert.equal(data.summary.net, 4670000);
  assert.equal(data.summary.prev.clientIncome, 900000);
  assert.deepEqual(data.sources.clients.kinds.contract, { amount: 4000000, count: 2 });
  // The new contract's first payment vs. an older contract's installment.
  assert.deepEqual(data.sources.clients.contractSplit, { newContracts: { amount: 3000000, count: 1 }, earlier: { amount: 1000000, count: 1 } });
  assert.deepEqual(data.sources.methods.map((m) => [m.method, m.amount]), [["card", 3000000], ["cash", 1450000]]);
  assert.equal(data.sources.people.find((p) => p.name === "Nodira").reportIncome, 250000);

  const c = data.consultations;
  assert.equal(c.total, 3);
  assert.deepEqual(c.status, { upcoming: 0, attended: 2, noShow: 1, unmarked: 0, cancelled: 1 });
  assert.deepEqual(c.format, { office: 2, online: 1 });
  assert.deepEqual(c.paid, { count: 1, amount: 450000 });
  // Came, but no fee recorded.
  assert.deepEqual(c.unpaidHeld.map((a) => a.id), [102]);
  assert.equal(c.missing, 450000);
  assert.equal(c.clients, 2);
  assert.equal(c.converted, 1);

  assert.equal(data.contracts.count, 1);
  assert.equal(data.contracts.list[0].remaining, 7000000);
  assert.equal(data.owed.total, 7000000 + 4000000);
  assert.equal(data.owed.aging.d30.amount, 7000000);
  assert.equal(data.owed.aging.d180.amount, 4000000);

  const law = data.lawyers.find((l) => l.lawyer === "Rashidova Madina");
  assert.equal(law.received, 4450000);
  assert.equal(law.consultationFees, 450000);
  assert.equal(law.consultations, 3);
  assert.equal(data.trend.at(-1).net, 4670000);
});

test("a consultation fee doesn't count towards the contract", () => {
  const cl = require("../src/services/clients");
  const s = cl.paymentSummary(10000000, [
    { amount: 450000, kind: "consultation" },
    { amount: 3000000, kind: "contract" },
    { amount: 500000, kind: "other" },
  ]);
  assert.deepEqual(s, { paid: 3500000, remaining: 6500000, state: "partial" });
});

test("working days: Monday to Saturday, and how many have passed", () => {
  const { workCalendar } = require("../src/services/performance");
  const cal = workCalendar("2026-10", "2026-10-07");
  assert.equal(cal.dates.length, 31);
  // October 2026: 4 Sundays (4, 11, 18, 25) off.
  assert.equal(cal.work.length, 27);
  assert.deepEqual(cal.workSoFar, ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-05", "2026-10-06", "2026-10-07"]);
});
