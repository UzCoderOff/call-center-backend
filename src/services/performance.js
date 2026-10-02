const prisma = require("../lib/prisma");
const { firmDate, firmDayRange, isoWeekday, shiftDate } = require("../lib/firmTime");
const { computeCallStats } = require("./stats");
const { autoReportDays } = require("./autoReport");
const { reportMoney } = require("./reportMoney");
const { workingDates } = require("./workdays");
const { BUILTIN, MONEY, FINANCE_ONLY, parseKey, formMeasures, reportValues, targetsFor } = require("./performanceMetrics");
const { scheduleOf } = require("./installments");
const { jobOf } = require("../lib/jobs");
const { strikeCounts } = require("./strikes");

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
//   income       all of it together (a measure you can set a target on):
//                money brought in plus report income — in soʻm only with
//                Moliya, otherwise as percent of the target
//   cost         what they cost that month (EmployeeCost), per consultation,
//                per contract, and against the money brought in — Moliya only
//   discipline   daily reports sent on working days; tasks done on time
//
// Not everyone works with clients: each person is measured by the work they
// do — their job (Employee.job, src/lib/jobs.js; services/performanceMetrics.js).
// "Client work" (calls, bookings, consultations, contracts) for the call
// center; "coordinator work" (the cases handed to them after the contract:
// money collected on them, cases looked after, what's overdue) for
// coordinators; "office work" — the numbers in their daily report form
// (documents translated, people served, money taken…) — for everyone who
// fills one in. Targets are per person on any of those measures.
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

// employees: [{ id, userId, name, active, createdAt, job, collectCalls, autoReport, alsoForm, reportTemplateId, position, office }]
// finance: include contract money and cost. detail: also day by day and six
// months back (one person). selfId: the viewer's own Employee.id — a
// coordinator sees the money collected on their own cases.
async function monthPerformance({ month, employees, finance, detail = false, today = firmDate(), selfId = null }) {
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

  const [callStats, bookings, cases, brought, taken, reports, templates, tasks, costs, days, coordinated] = await Promise.all([
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
    prisma.reportTemplate.findMany({ select: { id: true, name: true, fields: true } }),
    prisma.task.findMany({ where: { assigneeId: { in: userIds }, dueAt: { gte: new Date(msFrom), lte: new Date(msTo) } }, select: { assigneeId: true, dueAt: true, doneAt: true } }),
    finance ? costsFor(ids, month) : new Map(),
    // Day by day (calls in/out, bookings made, clients added): only up to today.
    Promise.all(employees.map((e) => (started ? autoReportDays(e, cal.first, until) : []))),
    // Coordinators: the cases handed to them, with their payments and
    // schedules.
    prisma.clientCase.findMany({
      where: { coordinatorId: { in: ids } },
      select: { coordinatorId: true, status: true, contractAmount: true, payments: { select: { amount: true, kind: true, date: true } }, installments: { select: { dueDate: true, amount: true } } },
    }),
  ]);

  const byUser = new Map(employees.map((e) => [e.userId, e.id]));
  // Late call-back strikes this month (services/strikes.js).
  const { rules: strikeRule, counts: strikeMap } = await strikeCounts(ids, month);
  // Report money is needed for everyone's income measure; it's shown in soʻm
  // only with Moliya.
  const { entries: money, unclassified: unmarked } = reportMoney(reports, templates);
  const targets = await targetsFor(employees, month);
  const templateById = new Map(templates.map((t) => [t.id, t]));
  // A report measure's name: from the form as it is now (or as it was).
  const labelOf = (key) => {
    const k = parseKey(key);
    const form = k && templateById.get(k.templateId);
    const m = form && formMeasures(form).find((x) => x.key === key);
    return m ? { label: m.label, unit: m.unit, form: m.form } : { label: key, unit: "count", form: null };
  };
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
    const myTargets = targets.get(e.id) || new Map();
    const targetC = myTargets.get("consultations") ?? null;
    const targetK = myTargets.get("contracts") ?? null;
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
    const reportIncome = myMoney.filter((x) => x.kind === "income").reduce((t, x) => t + x.amount, 0);
    // All income: everything brought in on their clients plus report income.
    const income = myBrought.reduce((t, p) => t + p.amount, 0) + reportIncome;
    if (finance) {
      moneyOut.reportIncome = reportIncome;
      moneyOut.reportExpense = myMoney.filter((x) => x.kind === "expense").reduce((t, x) => t + x.amount, 0);
      moneyOut.income = income;
      // Money in their reports that isn't counted yet: the question isn't
      // marked Tushum or Xarajat in the form editor.
      moneyOut.unmarked = unmarked.reduce((t, u) => t + (u.byEmployee[e.id] || 0), 0);
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

    // --------------------------------------------- what they're measured on
    const myReports = own(reports, (r) => r.employeeId);
    const values = reportValues(myReports);
    // Client work: they book consultations, did client work this month, or
    // are call center (calls collected, the automatic report alone). A
    // monitored phone with a form to fill in is someone with another job.
    // The developer can settle it per person (workKind): "office" for
    // someone whose calls are collected but whose job is the office work.
    // What they're measured on is their job (set by the developer).
    const kind = jobOf(e);
    const clientActivity = Boolean(consulted.length || signed.length || mine.length || bookingsOut.made);
    const clientWork = kind === "call_center";
    const coordinatorWork = kind === "coordinator";
    // Office work: they fill in a report form (or sent reports this month
    // without doing client work). A form left on someone switched to the
    // automatic report alone doesn't count.
    const asksForm = mode === "form" || mode === "auto+form";
    const form = e.reportTemplateId && asksForm ? templateById.get(e.reportTemplateId) : null;
    const officeWork = kind === "office" || Boolean(form || (myReports.length && !clientWork && !coordinatorWork));

    // ------------------------------------------------------- coordinator
    // Money collected this month on the cases handed to them (contract
    // payments — not consultation fees), the cases they look after, and
    // what's overdue on them today.
    const myCoordinated = coordinated.filter((k) => k.coordinatorId === e.id);
    const collectedList = myCoordinated.flatMap((k) => k.payments.filter((p) => p.kind !== "consultation" && inMonth(p.date)));
    const collected = collectedList.reduce((t, p) => t + p.amount, 0);
    const overdueNow = myCoordinated.filter((k) => k.installments.length).map((k) => scheduleOf(k.installments, k.payments, today).overdue);
    const coordinator = coordinatorWork || myCoordinated.length
      ? {
          cases: myCoordinated.filter((k) => k.status === "contract").length,
          finished: myCoordinated.filter((k) => k.status === "done").length,
          collected,
          payments: collectedList.length,
          overdue: overdueNow.reduce((t, v) => t + v, 0),
          overdueCases: overdueNow.filter((v) => v > 0).length,
        }
      : null;
    // A coordinator's money: theirs to see, and Moliya's.
    const seesCollected = finance || selfId === e.id;
    if (coordinator && !seesCollected) {
      delete coordinator.collected;
      delete coordinator.overdue;
    }
    const builtinValue = {
      consultations: consulted.length,
      contracts: signed.length,
      bookings: bookingsOut.made,
      calls_answered: calls?.answered ?? 0,
      fees: moneyOut.brought.consultation,
      income,
      collected,
      cases: coordinator?.cases ?? 0,
    };
    const measure = (key) => {
      const target = myTargets.get(key) ?? null;
      const value = BUILTIN.includes(key) ? builtinValue[key] : values.get(key)?.total || 0;
      const info = BUILTIN.includes(key) ? { label: null, unit: MONEY.has(key) ? "money" : "count", form: null } : labelOf(key);
      const m = { key, builtin: BUILTIN.includes(key), ...info, value, target, expected: expected(target), pct: pct(value, target) };
      // Without Moliya: how far along, in percent — no soʻm (it would show
      // contract money).
      const hide = FINANCE_ONLY.has(key) ? !finance : key === "collected" ? !seesCollected : false;
      if (hide) return { ...m, value: null, target: null, expected: null, hidden: true, hasTarget: target != null, expectedPct: pct(m.expected, target) };
      return m;
    };
    // Targets first; then what fits their work.
    const keys = [...myTargets.keys()];
    if (clientWork) for (const k of ["consultations", "contracts"]) if (!keys.includes(k)) keys.push(k);
    if (coordinatorWork) for (const k of ["collected", "cases"]) if (!keys.includes(k)) keys.push(k);
    if (officeWork && form) for (const m of formMeasures(form)) if (!keys.includes(m.key)) keys.push(m.key);
    const metrics = keys.map(measure);

    const row = {
      // clientActivity: they did some client work (shown on their page) even
      // when it isn't what they're measured on.
      work: { kind, client: clientWork, coordinator: coordinatorWork, office: officeWork, clientActivity },
      coordinator,
      // With the rule on (or any given): this month's count against the limit.
      strikes: strikeRule.enabled || strikeMap.get(e.id)?.count ? { ...strikeMap.get(e.id), minutes: strikeRule.minutes } : null,
      metrics,
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
      const perDay = new Map(cal.dates.filter((d) => d <= until).map((d) => [d, { date: d, answered: 0, missed: 0, booked: 0, consultations: 0, contracts: 0, fees: 0, brought: 0, income: 0 }]));
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
        if (finance) {
          x.brought += p.amount;
          x.income += p.amount;
        }
      }
      if (finance) for (const r of myMoney) if (r.kind === "income" && perDay.has(r.date)) perDay.get(r.date).income += r.amount;
      for (const x of perDay.values()) {
        x.measures = {};
        for (const [key, v] of values) if (v.byDate.has(x.date)) x.measures[key] = v.byDate.get(x.date);
      }
      row.days = [...perDay.values()];
      row.workDates = workMine;
      // Office work: each report measure's month total, its daily average
      // over the days they worked, and (tables) by service.
      row.office = officeWork
        ? metrics
            .filter((m) => !m.builtin)
            .map((m) => {
              const v = values.get(m.key);
              return { ...m, perWorkDay: workMineSoFar.length ? Math.round((m.value / workMineSoFar.length) * 10) / 10 : null, groups: v ? [...v.groups].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total) : [] };
            })
        : [];
    }
    return row;
  });

  return { month, today, workDays: officeWork.length, workDaysSoFar: officeWork.filter((d) => d <= today).length, rows };
}

// Six months up to `month` for one person: consultations, contracts, money
// brought in and all income (contract money only with Moliya), and their
// report measures.
async function history(employee, month, finance) {
  const first = shiftMonth(month, -5);
  const range = { gte: `${first}-01`, lte: `${month}-31` };
  const [cases, brought, reports, templates] = await Promise.all([
    prisma.clientCase.findMany({
      where: { operatorId: employee.id, OR: [{ consultationDate: range }, { contractDate: range }] },
      select: { consultationDate: true, contractDate: true, contractAmount: true },
    }),
    prisma.payment.findMany({
      where: { date: range, OR: [{ case: { operatorId: employee.id } }, ...(employee.userId ? [{ caseId: null, appointment: { bookedById: employee.userId } }] : [])] },
      select: { date: true, amount: true, kind: true },
    }),
    prisma.report.findMany({ where: { employeeId: employee.id, date: range }, select: { id: true, employeeId: true, date: true, templateId: true, fields: true, answers: true } }),
    finance ? prisma.reportTemplate.findMany({ select: { id: true, name: true, fields: true } }) : [],
  ]);
  const months = Array.from({ length: 6 }, (_, i) => ({ month: shiftMonth(first, i), consultations: 0, contracts: 0, ...(finance ? { contracted: 0, brought: 0, income: 0 } : {}), fees: 0, measures: {} }));
  for (const m of months) {
    for (const [key, v] of reportValues(reports.filter((r) => r.date.startsWith(m.month)))) m.measures[key] = v.total;
  }
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
    if (finance) {
      m.brought += p.amount;
      m.income += p.amount;
    }
  }
  if (finance) {
    for (const x of reportMoney(reports, templates).entries) {
      const m = x.kind === "income" && at(x.date);
      if (m) m.income += x.amount;
    }
  }
  return months;
}

module.exports = { monthPerformance, history, workCalendar, costsFor, reportModeOf, WORK_DAYS };
