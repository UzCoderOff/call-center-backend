const cl = require("./clients");
const { groupEntries } = require("./reportMoney");
const { scheduleOf } = require("./installments");

// The Moliya page's numbers for one month, worked out from plain rows (the
// route loads them — src/routes/finance.js). Kept separate so every figure
// can be checked by a test.
//
// How the figures are counted (the page explains the same to the reader):
// - Money is counted on the day it was received (a payment's date, a
//   report's day), not when the contract was signed or the visit happened.
// - Income = client payments recorded in Ledger (consultation fees,
//   contract payments, other) + report money marked "income".
// - Expenses = report money marked "expense". Net = income - expenses.
// - Contracted = contracts whose contract date is in the month.
// - Owed = on every contract: amount - payments towards it (not the
//   consultation fee — that pays for the consultation), today. With a
//   payment schedule, split into overdue / due soon / later
//   (services/installments.js); without one, "no schedule".

const KINDS = ["consultation", "contract", "other"];
const AGING = [
  { key: "d30", max: 30 },
  { key: "d90", max: 90 },
  { key: "d180", max: 180 },
  { key: "older", max: Infinity },
];

const monthOf = (date) => date.slice(0, 7);
function shiftMonth(month, by) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}
const shiftDay = (date, days) => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + days)).toISOString().slice(0, 10);
const dayNumber = (date) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86400000;
const sum = (list, pick = (x) => x.amount) => list.reduce((s, x) => s + (pick(x) || 0), 0);
const byAmount = (a, b) => b.amount - a.amount;

function tally(map, key, init) {
  if (!map.has(key)) map.set(key, init());
  return map.get(key);
}

// payments      the month's client payments: { id, date, amount, kind, method, note, client, case, recordedBy, appointment }
//               case: { id, matter, lawyer, lawyerId, contractDate } | null; appointment: { format, ownerId } | null
// trendPayments six months of client payments: { date, amount, kind }
// cases         every case with a contract: { id, contractAmount, contractDate, lawyer, lawyerId, matter, client, payments: [{ amount, date }] }
// appointments  the month's appointments: { id, date, start, status, format, clientId, clientName, ownerId, calendarName, paid }
// contractDates clientId -> the dates their contracts were signed (for "came to a consultation, then signed")
// report        { entries, unclassified } for the month, or null (a lawyer's view has no report money)
// reportTrend   six months of report money entries (for the trend), or []
// names         user id -> name (lawyers)
// channels      { newClients: [source], consultations: [source] } — where the
//               month's clients came from — or null (a lawyer's view)
function buildFinance({ month, today, fee, payments, trendPayments, cases, appointments, contractDates, report, reportTrend, names, channels = null }) {
  const firstMonth = shiftMonth(month, -5);

  // ---------------------------------------------------------- lawyers
  const lawyers = new Map();
  // Older cases have only the lawyer's name typed in: the same person as the
  // account with that name.
  const idByName = new Map([...names].map(([id, name]) => [name, id]));
  const lawyerKey = (id, name) => {
    const known = id || (name && idByName.get(name));
    return known ? `u${known}` : name ? `n${name}` : "none";
  };
  const lawyerRow = (id, name) =>
    tally(lawyers, lawyerKey(id, name), () => ({
      lawyer: (id && names.get(id)) || name || null,
      contracts: 0,
      contracted: 0,
      received: 0,
      consultationFees: 0,
      contractPayments: 0,
      owed: 0,
      consultations: 0,
      attended: 0,
    }));

  // ------------------------------------------------- client payments
  const kinds = Object.fromEntries(KINDS.map((k) => [k, { amount: 0, count: 0 }]));
  const contractSplit = { newContracts: { amount: 0, count: 0 }, earlier: { amount: 0, count: 0 } };
  const methods = new Map();
  const people = new Map();
  const days = new Map();
  const personRow = (name) => tally(people, name || "", () => ({ name: name || null, clientPayments: 0, clientCount: 0, reportIncome: 0, reportExpense: 0 }));
  const dayRow = (date) => tally(days, date, () => ({ date, consultation: 0, contract: 0, other: 0, reportIncome: 0, expenses: 0 }));

  for (const p of payments) {
    const kind = KINDS.includes(p.kind) ? p.kind : "other";
    kinds[kind].amount += p.amount;
    kinds[kind].count += 1;
    if (kind === "contract") {
      const fresh = p.case?.contractDate && monthOf(p.case.contractDate) === month;
      const bucket = fresh ? contractSplit.newContracts : contractSplit.earlier;
      bucket.amount += p.amount;
      bucket.count += 1;
    }
    const m = tally(methods, p.method || "none", () => ({ method: p.method || "none", amount: 0, count: 0 }));
    m.amount += p.amount;
    m.count += 1;
    const who = personRow(p.recordedBy);
    who.clientPayments += p.amount;
    who.clientCount += 1;
    dayRow(p.date)[kind] += p.amount;
    // Whose money: the case's lawyer, else (a fee without a case) the
    // lawyer whose calendar the consultation was in.
    const row = p.case ? lawyerRow(p.case.lawyerId, p.case.lawyer) : p.appointment?.ownerId ? lawyerRow(p.appointment.ownerId, null) : null;
    if (row) {
      row.received += p.amount;
      if (kind === "consultation") row.consultationFees += p.amount;
      if (kind === "contract") row.contractPayments += p.amount;
    }
  }
  const clientIncome = sum(payments);

  // ------------------------------------------------------ report money
  const entries = report?.entries || [];
  const income = entries.filter((e) => e.kind === "income");
  const expense = entries.filter((e) => e.kind === "expense");
  for (const e of entries) {
    const who = personRow(e.person);
    if (e.kind === "income") {
      who.reportIncome += e.amount;
      dayRow(e.date).reportIncome += e.amount;
    } else {
      who.reportExpense += e.amount;
      dayRow(e.date).expenses += e.amount;
    }
  }
  const reportIncome = sum(income);
  const expenses = sum(expense);

  // ------------------------------------------ contracts and what's owed
  const contracts = [];
  const owedBy = new Map();
  const aging = Object.fromEntries([...AGING.map((a) => a.key), "noDate"].map((k) => [k, { amount: 0, count: 0 }]));
  let owed = 0;
  const soonLimit = shiftDay(today, 14);
  const plan = { overdue: 0, overdueCases: 0, dueSoon: 0, later: 0, unscheduled: 0 };
  const overdueList = [];
  const soonList = [];
  for (const k of cases) {
    const row = lawyerRow(k.lawyerId, k.lawyer);
    const { paid, remaining } = cl.paymentSummary(k.contractAmount, k.payments);
    if (k.contractDate && monthOf(k.contractDate) === month) {
      row.contracts += 1;
      row.contracted += k.contractAmount;
      contracts.push({
        caseId: k.id,
        client: { id: k.client.id, name: k.client.name },
        lawyer: row.lawyer,
        matter: k.matter,
        date: k.contractDate,
        amount: k.contractAmount,
        paid,
        remaining,
      });
    }
    if (remaining > 0 && Array.isArray(k.installments) && k.installments.length) {
      const s = scheduleOf(k.installments, k.payments, today);
      plan.overdue += s.overdue;
      if (s.overdue > 0) {
        plan.overdueCases += 1;
        overdueList.push({ caseId: k.id, client: { id: k.client.id, name: k.client.name }, lawyer: row.lawyer, since: s.overdueSince, daysLate: dayNumber(today) - dayNumber(s.overdueSince), amount: s.overdue, next: s.next });
      }
      for (const i of s.items) {
        if (i.status === "due" || (i.status === "upcoming" && i.dueDate <= soonLimit)) {
          plan.dueSoon += i.left;
          soonList.push({ caseId: k.id, client: { id: k.client.id, name: k.client.name }, lawyer: row.lawyer, dueDate: i.dueDate, amount: i.left });
        } else if (i.status === "upcoming") plan.later += i.left;
      }
      // Owed beyond what the schedule lists.
      plan.unscheduled += Math.max(0, remaining - s.items.reduce((t, i) => t + i.left, 0));
    } else if (remaining > 0) plan.unscheduled += remaining;
    if (remaining > 0) {
      owed += remaining;
      row.owed += remaining;
      const age = k.contractDate ? dayNumber(today) - dayNumber(k.contractDate) : null;
      const bucket = age === null ? "noDate" : AGING.find((a) => age <= a.max).key;
      aging[bucket].amount += remaining;
      aging[bucket].count += 1;
      const c = tally(owedBy, k.client.id, () => ({
        client: { id: k.client.id, name: k.client.name, archived: Boolean(k.client.archivedAt) },
        owed: 0,
        contracted: 0,
        paid: 0,
        since: null,
        lastPayment: null,
        lawyers: new Set(),
      }));
      c.owed += remaining;
      c.contracted += k.contractAmount;
      c.paid += paid;
      if (k.contractDate && (!c.since || k.contractDate < c.since)) c.since = k.contractDate;
      for (const p of k.payments) if (p.kind !== "consultation" && (!c.lastPayment || p.date > c.lastPayment)) c.lastPayment = p.date;
      if (row.lawyer) c.lawyers.add(row.lawyer);
    }
  }
  contracts.sort((a, b) => (a.date < b.date ? 1 : -1));
  const contracted = sum(contracts);

  // ----------------------------------------------------- consultations
  const active = appointments.filter((a) => a.status !== "cancelled");
  const past = (a) => a.date < today;
  const unpaidHeld = active
    .filter((a) => !a.paid && (a.status === "attended" || (a.status === "booked" && past(a))))
    .map((a) => ({ id: a.id, date: a.date, start: a.start, clientId: a.clientId, clientName: a.clientName, lawyer: (a.ownerId && names.get(a.ownerId)) || a.calendarName, format: a.format, status: a.status }))
    .sort((a, b) => (a.date === b.date ? a.start - b.start : a.date < b.date ? -1 : 1));
  const attendedClients = new Map(); // clientId -> first attended date this month
  for (const a of active) {
    if (a.status === "attended" && a.clientId && (!attendedClients.has(a.clientId) || a.date < attendedClients.get(a.clientId))) {
      attendedClients.set(a.clientId, a.date);
    }
    const row = lawyerRow(a.ownerId, a.calendarName);
    row.consultations += 1;
    if (a.status === "attended") row.attended += 1;
  }
  const converted = [...attendedClients].filter(([clientId, date]) => (contractDates.get(clientId) || []).some((d) => d >= date)).length;
  const byCalendar = new Map();
  for (const a of appointments) {
    const r = tally(byCalendar, a.ownerId || a.calendarName, () => ({
      lawyer: (a.ownerId && names.get(a.ownerId)) || a.calendarName,
      total: 0,
      attended: 0,
      noShow: 0,
      cancelled: 0,
      online: 0,
      paid: 0,
      amount: 0,
    }));
    if (a.status === "cancelled") {
      r.cancelled += 1;
      continue;
    }
    r.total += 1;
    if (a.status === "attended") r.attended += 1;
    if (a.status === "no_show") r.noShow += 1;
    if (a.format === "online") r.online += 1;
    if (a.paid) {
      r.paid += 1;
      r.amount += a.paid.amount;
    }
  }
  const consultations = {
    total: active.length,
    status: {
      upcoming: active.filter((a) => a.status === "booked" && !past(a)).length,
      attended: active.filter((a) => a.status === "attended").length,
      noShow: active.filter((a) => a.status === "no_show").length,
      unmarked: active.filter((a) => a.status === "booked" && past(a)).length,
      cancelled: appointments.length - active.length,
    },
    format: { office: active.filter((a) => a.format !== "online").length, online: active.filter((a) => a.format === "online").length },
    paid: { count: active.filter((a) => a.paid).length, amount: sum(active.filter((a) => a.paid), (a) => a.paid.amount) },
    unpaid: active.filter((a) => !a.paid).length,
    unpaidHeld,
    fee,
    missing: unpaidHeld.length * fee,
    clients: attendedClients.size,
    converted,
    byLawyer: [...byCalendar.values()].sort((a, b) => b.total - a.total),
  };

  // ---------------------------------------------- where clients come from
  let channelRows = null;
  if (channels) {
    const map = new Map();
    const channel = (src) => tally(map, src || "none", () => ({ source: src || "none", newClients: 0, consultations: 0, contracts: 0, contracted: 0, received: 0 }));
    for (const s of channels.newClients) channel(s).newClients += 1;
    for (const s of channels.consultations) channel(s).consultations += 1;
    for (const k of cases) {
      if (!(k.contractDate && monthOf(k.contractDate) === month)) continue;
      const c = channel(k.client.source);
      c.contracts += 1;
      c.contracted += k.contractAmount;
    }
    for (const p of payments) channel(p.client?.source).received += p.amount;
    channelRows = [...map.values()].sort((a, b) => b.received - a.received || b.consultations - a.consultations || b.newClients - a.newClients);
  }

  // ------------------------------------------------------------- trend
  const trend = [];
  for (let i = 0; i < 6; i++) {
    trend.push({ month: shiftMonth(firstMonth, i), consultation: 0, contract: 0, other: 0, reportIncome: 0, expenses: 0, contracted: 0 });
  }
  const trendRow = (date) => trend.find((t) => t.month === monthOf(date));
  for (const p of trendPayments) {
    const t = trendRow(p.date);
    if (t) t[KINDS.includes(p.kind) ? p.kind : "other"] += p.amount;
  }
  for (const e of reportTrend) {
    const t = trendRow(e.date);
    if (t) t[e.kind === "income" ? "reportIncome" : "expenses"] += e.amount;
  }
  for (const k of cases) {
    const t = k.contractDate && trendRow(k.contractDate);
    if (t) t.contracted += k.contractAmount;
  }
  for (const t of trend) {
    t.clientIncome = t.consultation + t.contract + t.other;
    t.income = t.clientIncome + t.reportIncome;
    t.net = t.income - t.expenses;
  }
  const prev = trend[trend.length - 2];

  return {
    summary: {
      income: clientIncome + reportIncome,
      clientIncome,
      reportIncome,
      expenses,
      net: clientIncome + reportIncome - expenses,
      contracted,
      contractCount: contracts.length,
      owed,
      owedClients: owedBy.size,
      prev: { income: prev.income, clientIncome: prev.clientIncome, reportIncome: prev.reportIncome, expenses: prev.expenses, net: prev.net, contracted: prev.contracted },
    },
    sources: {
      clients: { total: clientIncome, count: payments.length, kinds, contractSplit },
      reports: report
        ? {
            income: { total: reportIncome, count: income.length, items: groupEntries(income) },
            expense: { total: expenses, count: expense.length, items: groupEntries(expense) },
            unclassified: report.unclassified,
          }
        : null,
      methods: [...methods.values()].sort(byAmount),
      people: [...people.values()]
        .map((p) => ({ ...p, total: p.clientPayments + p.reportIncome }))
        .sort((a, b) => b.total - a.total || b.reportExpense - a.reportExpense),
      days: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
      channels: channelRows,
    },
    consultations,
    contracts: { count: contracts.length, total: contracted, average: contracts.length ? Math.round(contracted / contracts.length) : 0, list: contracts },
    owed: {
      total: owed,
      clients: owedBy.size,
      plan,
      overdueList: overdueList.sort((a, b) => b.daysLate - a.daysLate || b.amount - a.amount),
      soonList: soonList.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : b.amount - a.amount)),
      aging,
      top: [...owedBy.values()]
        .sort((a, b) => b.owed - a.owed)
        .slice(0, 30)
        .map((c) => ({ ...c, lawyers: [...c.lawyers] })),
    },
    lawyers: [...lawyers.values()]
      .filter((r) => r.contracted || r.received || r.owed || r.consultations)
      .sort((a, b) => b.contracted + b.received - (a.contracted + a.received) || b.consultations - a.consultations),
    trend,
    payments: payments.slice(0, 300).map((p) => ({
      id: p.id,
      date: p.date,
      amount: p.amount,
      kind: p.kind,
      method: p.method,
      note: p.note,
      client: p.client,
      matter: p.case?.matter ?? null,
      lawyer: p.case ? (p.case.lawyerId && names.get(p.case.lawyerId)) || p.case.lawyer : p.appointment?.ownerId ? names.get(p.appointment.ownerId) ?? null : null,
      format: p.appointment?.format ?? null,
      recordedBy: p.recordedBy,
    })),
    reportEntries: entries
      .slice()
      .sort((a, b) => (a.date === b.date ? b.amount - a.amount : a.date < b.date ? 1 : -1))
      .slice(0, 300)
      .map(({ reportId, date, person, form, label, column, service, amount, kind }) => ({ reportId, date, person, form, label, column, service, amount, kind })),
  };
}

module.exports = { buildFinance, shiftMonth, monthOf };
