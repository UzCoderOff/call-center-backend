const prisma = require("../lib/prisma");
const { firmDate, firmDayRange, isoWeekday, shiftDate } = require("../lib/firmTime");
const { computeCallStats } = require("./stats");
const { autoReportDays } = require("./autoReport");
const { reportMoney } = require("./reportMoney");
const { workingDates } = require("./workdays");

// Each person's month at work, for the performance page ("Natijalar"):
//
//   calls        answered / missed, in / out, missed ones called back and
//                how fast (median), talk time — for people whose calls are
//                collected
//   bookings     consultations they booked, and what happened to the ones
//                that fall in the month: came, didn't, cancelled, online, paid
//   targets      consultations and contracts on the cases they're the
//                operator of, against their position's monthly target and
//                where they should be by today (working days, Mon–Sat)
//   conversion   of this month's consultations, how many have signed so far
//   money        brought in: payments on their cases (and fees for their
//                bookings without a case); taken: what they recorded, by
//                method (the cash they should hand over); report income and
//                expenses — contract money only with Moliya
//   cost         what they cost that month (EmployeeCost), per consultation,
//                per contract, and against the money brought in — Moliya only
//   discipline   daily reports sent on working days; tasks done on time
//
// A month is counted by dates in the firm's timezone. "So far" stops at
// today for the current month. Working days are each person's own
// (src/services/workdays.js): their weekly pattern, confirmed holidays if
// those are days off for them, and their approved days away.

const WORK_DAYS = [1, 2, 3, 4, 5, 6]; // Monday–Saturday

function monthDates(month) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

function shiftMonth(month, by) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}

// The month's Monday–Saturday days, and how many have passed by `today`.
function workCalendar(month, today) {
  const dates = monthDates(month);
  const work = dates.filter((d) => WORK_DAYS.includes(isoWeekday(d)));
  return { first: dates[0], last: dates[dates.length - 1], dates, work, workSoFar: work.filter((d) => d <= today) };
}

const reportModeOf = (e) => (e.autoReport ? (e.alsoForm ? "auto+form" : "auto") : e.reportTemplateId ? "form" : "none");
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null);

// The cost in force in `month` for each person: their latest entry from that
// month or before.
async function costsFor(employeeIds, month) {
  const rows = await prisma.employeeCost.findMany({
    where: { employeeId: { in: employeeIds }, fromMonth: { lte: month } },
    orderBy: { fromMonth: "desc" },
    select: { employeeId: true, fromMonth: true, amount: true, note: true },
  });
  const map = new Map();
  for (const r of rows) if (!map.has(r.employeeId)) map.set(r.employeeId, r);
  return map;
}

// employees: [{ id, userId, name, active, createdAt, collectCalls, autoReport, alsoForm, reportTemplateId, position, office }]
// finance: include contract money and cost. detail: also day by day and six
// months back (one person).
async function monthPerformance({ month, employees, finance, detail = false, today = firmDate() }) {
  const cal = workCalendar(month, today);
  const until = today < cal.last ? today : cal.last; // "so far"
  const started = until >= cal.first;
  const ids = employees.map((e) => e.id);
  const userIds = employees.map((e) => e.userId).filter(Boolean);
  const dateRange = { gte: cal.first, lte: cal.last };
  const msFrom = firmDayRange(cal.first).from;
  const msTo = firmDayRange(cal.last).to;

  // Each person's working days this month; and the office's (Mon–Sat,
  // holidays off) for the page's "N of M working days" line.
  const office = { id: -1, workDays: "123456", holidaysOff: true };
  const calendars = await workingDates([...employees, office], cal.first, cal.last);
  const officeWork = calendars.byEmployee.get(-1).work;

  const [callStats, bookings, cases, brought, taken, reports, templates, tasks, costs, days] = await Promise.all([
    computeCallStats({ employeeIds: ids, from: msFrom, to: msTo }),
    prisma.appointment.findMany({
      where: { bookedById: { in: userIds }, date: dateRange },
      select: { bookedById: true, date: true, end: true, status: true, format: true, payments: { where: { kind: "consultation" }, select: { amount: true } } },
    }),
    prisma.clientCase.findMany({
      where: { operatorId: { in: ids }, OR: [{ consultationDate: dateRange }, { contractDate: dateRange }] },
      select: { operatorId: true, consultationDate: true, contractDate: true, contractAmount: true },
    }),
    // Brought in: payments on their cases, and consultation fees for their
    // bookings that have no case.
    prisma.payment.findMany({
      where: { date: dateRange, OR: [{ case: { operatorId: { in: ids } } }, { caseId: null, appointment: { bookedById: { in: userIds } } }] },
      select: { amount: true, kind: true, date: true, case: { select: { operatorId: true } }, appointment: { select: { bookedById: true } } },
    }),
    // Taken: payments they recorded.
    prisma.payment.findMany({ where: { date: dateRange, recordedById: { in: userIds } }, select: { amount: true, kind: true, method: true, recordedById: true } }),
    prisma.report.findMany({ where: { employeeId: { in: ids }, date: dateRange }, select: { id: true, employeeId: true, date: true, templateId: true, fields: true, answers: true } }),
    finance ? prisma.reportTemplate.findMany({ select: { id: true, name: true, fields: true } }) : [],
    prisma.task.findMany({ where: { assigneeId: { in: userIds }, dueAt: { gte: new Date(msFrom), lte: new Date(msTo) } }, select: { assigneeId: true, dueAt: true, doneAt: true } }),
    finance ? costsFor(ids, month) : new Map(),
    // Day by day (calls in/out, bookings made, clients added): only up to today.
    Promise.all(employees.map((e) => (started ? autoReportDays(e, cal.first, until) : []))),
  ]);

  const byUser = new Map(employees.map((e) => [e.userId, e.id]));
  const money = finance ? reportMoney(reports, templates).entries : [];
  const now = Date.now();

  const rows = employees.map((e, index) => {
    const own = (list, pick) => list.filter((x) => pick(x) === e.id);
    const myDays = days[index];
    const joined = e.createdAt ? firmDate(new Date(e.createdAt)) : cal.first;

    // ------------------------------------------------------------ calls
    let calls = null;
    if (e.collectCalls) {
      const s = callStats.byEmployee.get(e.id);
      const sum = (key) => myDays.reduce((t, d) => t + (d.calls?.[key] || 0), 0);
      const total = s?.totalCalls || 0;
      const missed = s?.missedCalls || 0;
      calls = {
        total,
        answered: total - missed,
        missed,
        incoming: sum("incoming"),
        outgoing: sum("outgoing"),
        reached: s?.followUp.reached || 0,
        needsCallback: s?.followUp.needsCallback || 0,
        talkSeconds: s?.talkSeconds || 0,
        medianCallbackSec: s?.followUp.medianCallbackSec ?? null,
        answerRate: pct(total - missed, total),
        reachedRate: pct(s?.followUp.reached || 0, missed),
      };
    }

    // --------------------------------------------------------- bookings
    const mine = bookings.filter((a) => byUser.get(a.bookedById) === e.id);
    const active = mine.filter((a) => a.status !== "cancelled");
    const past = (a) => a.date < today;
    const bookingsOut = {
      made: myDays.reduce((t, d) => t + d.booked, 0),
      total: active.length,
      attended: active.filter((a) => a.status === "attended").length,
      noShow: active.filter((a) => a.status === "no_show").length,
      unmarked: active.filter((a) => a.status === "booked" && past(a)).length,
      upcoming: active.filter((a) => a.status === "booked" && !past(a)).length,
      cancelled: mine.length - active.length,
      online: active.filter((a) => a.format === "online").length,
      paid: active.filter((a) => a.payments.length > 0).length,
      paidAmount: active.reduce((t, a) => t + a.payments.reduce((s, p) => s + p.amount, 0), 0),
    };

    // ---------------------------------------------- targets, conversion
    const myCases = own(cases, (k) => k.operatorId);
    const inMonth = (d) => d && d >= cal.first && d <= cal.last;
    const consulted = myCases.filter((k) => inMonth(k.consultationDate));
    const signed = myCases.filter((k) => inMonth(k.contractDate));
    // Where they should be by today: the target spread over their working
    // days (from the day they joined, if that's this month).
    const mineCal = calendars.byEmployee.get(e.id);
    const workMine = mineCal.work.filter((d) => d >= joined);
    const workMineSoFar = workMine.filter((d) => d <= today);
    const expected = (target) => (target ? Math.round((target * workMineSoFar.length) / Math.max(1, workMine.length)) : null);
    const targetC = e.position?.targetConsultations ?? null;
    const targetK = e.position?.targetContracts ?? null;
    const consultations = { count: consulted.length, target: targetC, expected: expected(targetC), pct: pct(consulted.length, targetC) };
    const contracts = { count: signed.length, target: targetK, expected: expected(targetK), pct: pct(signed.length, targetK) };
    if (finance) contracts.amount = signed.reduce((t, k) => t + (k.contractAmount || 0), 0);
    const cohortSigned = consulted.filter((k) => k.contractDate && k.contractDate >= k.consultationDate).length;
    const conversion = { consultations: consulted.length, signed: cohortSigned, rate: pct(cohortSigned, consulted.length) };

    // -------------------------------------------------------------- money
    const myBrought = brought.filter((p) => (p.case ? p.case.operatorId === e.id : byUser.get(p.appointment?.bookedById) === e.id));
    const kindSum = (list, kind) => list.filter((p) => (kind === "other" ? p.kind !== "consultation" && p.kind !== "contract" : p.kind === kind)).reduce((t, p) => t + p.amount, 0);
    const myTaken = taken.filter((p) => byUser.get(p.recordedById) === e.id);
    const visibleTaken = finance ? myTaken : myTaken.filter((p) => p.kind === "consultation");
    const methodSum = (m) => visibleTaken.filter((p) => (p.method || "none") === m).reduce((t, p) => t + p.amount, 0);
    const myMoney = money.filter((x) => x.employeeId === e.id);
    const moneyOut = {
      brought: finance
        ? { total: myBrought.reduce((t, p) => t + p.amount, 0), consultation: kindSum(myBrought, "consultation"), contract: kindSum(myBrought, "contract"), other: kindSum(myBrought, "other") }
        : { total: kindSum(myBrought, "consultation"), consultation: kindSum(myBrought, "consultation") },
      taken: {
        total: visibleTaken.reduce((t, p) => t + p.amount, 0),
        count: visibleTaken.length,
        cash: methodSum("cash"),
        card: methodSum("card"),
        transfer: methodSum("transfer"),
        none: methodSum("none"),
      },
    };
    if (finance) {
      moneyOut.reportIncome = myMoney.filter((x) => x.kind === "income").reduce((t, x) => t + x.amount, 0);
      moneyOut.reportExpense = myMoney.filter((x) => x.kind === "expense").reduce((t, x) => t + x.amount, 0);
    }

    // --------------------------------------------------------------- cost
    let cost;
    if (finance) {
      const c = costs.get(e.id);
      const value = moneyOut.brought.total + moneyOut.reportIncome;
      cost = c
        ? {
            amount: c.amount,
            fromMonth: c.fromMonth,
            note: c.note,
            perConsultation: consulted.length ? Math.round(c.amount / consulted.length) : null,
            perContract: signed.length ? Math.round(c.amount / signed.length) : null,
            value,
            net: value - c.amount,
            ratio: c.amount > 0 ? Math.round((value / c.amount) * 100) / 100 : null,
          }
        : { amount: null, value };
    }

    // --------------------------------------------------------- discipline
    const mode = reportModeOf(e);
    const sent = new Set(own(reports, (r) => r.employeeId).map((r) => r.date));
    // A form is due on each working day since they joined — today only
    // once it's in.
    const due = mode === "form" || mode === "auto+form" ? workMineSoFar.filter((d) => d < today || sent.has(d)) : [];
    const reportsOut = { mode, due: due.length, sent: due.filter((d) => sent.has(d)).length, missing: due.filter((d) => !sent.has(d)) };

    const myTasks = tasks.filter((t) => byUser.get(t.assigneeId) === e.id);
    const tasksOut = {
      total: myTasks.length,
      done: myTasks.filter((t) => t.doneAt).length,
      onTime: myTasks.filter((t) => t.doneAt && t.doneAt <= t.dueAt).length,
      late: myTasks.filter((t) => t.doneAt && t.doneAt > t.dueAt).length,
      open: myTasks.filter((t) => !t.doneAt && t.dueAt.getTime() >= now).length,
      overdue: myTasks.filter((t) => !t.doneAt && t.dueAt.getTime() < now).length,
    };

    const row = {
      employee: { id: e.id, name: e.name, active: e.active, position: e.position?.name ?? null, office: e.office?.name ?? null, collectCalls: e.collectCalls, workDays: e.workDays, holidaysOff: e.holidaysOff },
      workDays: { total: workMine.length, soFar: workMineSoFar.length, away: mineCal.off.filter((o) => o.kind !== "weekly" && o.date >= joined).map((o) => ({ date: o.date, kind: o.kind, name: o.name ?? null })) },
      calls,
      clientsAdded: myDays.reduce((t, d) => t + d.newClients, 0),
      bookings: bookingsOut,
      consultations,
      contracts,
      conversion,
      money: moneyOut,
      ...(finance ? { cost } : {}),
      reports: reportsOut,
      tasks: tasksOut,
    };

    if (detail) {
      // Day by day, up to today.
      const perDay = new Map(cal.dates.filter((d) => d <= until).map((d) => [d, { date: d, answered: 0, missed: 0, booked: 0, consultations: 0, contracts: 0, fees: 0, brought: 0 }]));
      for (const d of myDays) {
        const x = perDay.get(d.date);
        if (!x) continue;
        x.answered = d.calls?.answered || 0;
        x.missed = d.calls?.missed || 0;
        x.booked = d.booked;
      }
      for (const k of consulted) if (perDay.has(k.consultationDate)) perDay.get(k.consultationDate).consultations += 1;
      for (const k of signed) if (perDay.has(k.contractDate)) perDay.get(k.contractDate).contracts += 1;
      for (const p of myBrought) {
        const x = perDay.get(p.date);
        if (!x) continue;
        if (p.kind === "consultation") x.fees += p.amount;
        if (finance) x.brought += p.amount;
      }
      row.days = [...perDay.values()];
      row.workDates = workMine;
    }
    return row;
  });

  return { month, today, workDays: officeWork.length, workDaysSoFar: officeWork.filter((d) => d <= today).length, rows };
}

// Six months up to `month` for one person: consultations, contracts, and
// money brought in (contract money only with Moliya).
async function history(employee, month, finance) {
  const first = shiftMonth(month, -5);
  const range = { gte: `${first}-01`, lte: `${month}-31` };
  const [cases, brought] = await Promise.all([
    prisma.clientCase.findMany({
      where: { operatorId: employee.id, OR: [{ consultationDate: range }, { contractDate: range }] },
      select: { consultationDate: true, contractDate: true, contractAmount: true },
    }),
    prisma.payment.findMany({
      where: { date: range, OR: [{ case: { operatorId: employee.id } }, ...(employee.userId ? [{ caseId: null, appointment: { bookedById: employee.userId } }] : [])] },
      select: { date: true, amount: true, kind: true },
    }),
  ]);
  const months = Array.from({ length: 6 }, (_, i) => ({ month: shiftMonth(first, i), consultations: 0, contracts: 0, ...(finance ? { contracted: 0, brought: 0 } : {}), fees: 0 }));
  const at = (date) => date && months.find((m) => m.month === date.slice(0, 7));
  for (const k of cases) {
    const c = at(k.consultationDate);
    if (c) c.consultations += 1;
    const s = at(k.contractDate);
    if (s) {
      s.contracts += 1;
      if (finance) s.contracted += k.contractAmount || 0;
    }
  }
  for (const p of brought) {
    const m = at(p.date);
    if (!m) continue;
    if (p.kind === "consultation") m.fees += p.amount;
    if (finance) m.brought += p.amount;
  }
  return months;
}

module.exports = { monthPerformance, history, workCalendar, costsFor, reportModeOf, WORK_DAYS };
