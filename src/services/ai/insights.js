const prisma = require("../../lib/prisma");
const env = require("../../config/env");
const { canSeeFinance } = require("../../lib/finance");
const { firmNow, firmDayRange, isValidDate, shiftDate, weekStartOf } = require("../../lib/firmTime");
const { clientScope } = require("../../lib/clientAccess");
const { computeCallStats } = require("../stats");
const { scheduleOf } = require("../installments");

// Ledger AI's analysis lookups (2026-10-14) — the numbers behind "what's
// changing", not just "how many": week-by-week trends with each person's
// part, the clients who need attention now (the client radar), and why
// consultations don't continue. Used by the chat (tools.js) and the weekly
// and monthly reports (reports.js). Read-only; contract money only with
// Moliya; clients only the ones this person may see.

const DAY_MS = 24 * 60 * 60 * 1000;
const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: env.firmTimezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const when = (value) => (value == null ? null : stamp.format(new Date(value)));
const nameOf = (u) => u?.employee?.name || u?.name || u?.username || null;
const inRange = (d, from, to) => typeof d === "string" && d >= from && d <= to;
const short = (s, n = 200) => (s && String(s).length > n ? `${String(s).slice(0, n - 1)}…` : s || null);

// ------------------------------------------------------------- trends
// Week by week (Monday–Sunday, firm time), newest last: calls, new matters,
// consultations, contracts, lost ones, bookings — and money with Moliya.
// Plus each operator's consultations and contracts over the whole span.
async function trends(user, { weeks = 8, employeeIds = null } = {}) {
  const n = Math.min(26, Math.max(2, Number(weeks) || 8));
  const today = firmNow().date;
  const lastStart = weekStartOf(today);
  const starts = Array.from({ length: n }, (_, i) => shiftDate(lastStart, -7 * (n - 1 - i)));
  const from = starts[0];
  const caseWhere = {
    ...(employeeIds ? { operatorId: { in: employeeIds } } : {}),
    OR: [{ startDate: { gte: from } }, { consultationDate: { gte: from } }, { contractDate: { gte: from } }, { closedDate: { gte: from } }],
  };
  const money = canSeeFinance(user);
  const [cases, appointments, payments] = await Promise.all([
    prisma.clientCase.findMany({
      where: caseWhere,
      select: { startDate: true, consultationDate: true, contractDate: true, closedDate: true, status: true, operator: { select: { id: true, name: true } } },
    }),
    prisma.appointment.findMany({ where: { date: { gte: from, lte: today } }, select: { date: true, status: true } }),
    prisma.payment.findMany({ where: { date: { gte: from, lte: today } }, select: { date: true, amount: true, kind: true } }),
  ]);
  const out = [];
  for (const start of starts) {
    const end = shiftDate(start, 6) > today ? today : shiftDate(start, 6);
    const calls = await computeCallStats({ employeeIds, from: firmDayRange(start).from, to: firmDayRange(end).to });
    const week = {
      week: start,
      partial: end < shiftDate(start, 6) || undefined,
      calls: calls.totals.totalCalls,
      answered: calls.totals.answeredCalls,
      missed: calls.totals.missedCalls,
      missedNotCalledBack: calls.totals.followUp.needsCallback,
      newMatters: cases.filter((k) => inRange(k.startDate, start, end)).length,
      consultations: cases.filter((k) => inRange(k.consultationDate, start, end)).length,
      contracts: cases.filter((k) => inRange(k.contractDate, start, end)).length,
      lost: cases.filter((k) => k.status === "declined" && inRange(k.closedDate, start, end)).length,
      bookings: appointments.filter((a) => inRange(a.date, start, end) && a.status !== "cancelled").length,
      noShows: appointments.filter((a) => inRange(a.date, start, end) && a.status === "no_show").length,
      consultationFees: payments.filter((p) => inRange(p.date, start, end) && p.kind === "consultation").reduce((s, p) => s + p.amount, 0),
    };
    if (money) week.otherIncome = payments.filter((p) => inRange(p.date, start, end) && p.kind !== "consultation").reduce((s, p) => s + p.amount, 0);
    out.push(week);
  }
  const people = new Map();
  for (const k of cases) {
    if (!k.operator) continue;
    const p = people.get(k.operator.id) || { name: k.operator.name, consultations: [], contracts: [] };
    if (k.consultationDate >= from) p.consultations.push(k.consultationDate);
    if (k.contractDate >= from) p.contracts.push(k.contractDate);
    people.set(k.operator.id, p);
  }
  // Each person: per week too, so a trajectory shows (rising, falling).
  const perWeek = (dates) => starts.map((s) => dates.filter((d) => inRange(d, s, shiftDate(s, 6))).length);
  const byPerson = [...people.values()]
    .map((p) => ({ name: p.name, consultations: p.consultations.length, contracts: p.contracts.length, consultationsByWeek: perWeek(p.consultations), contractsByWeek: perWeek(p.contracts) }))
    .sort((a, b) => b.consultations - a.consultations)
    .slice(0, 15);
  return { weeks: out, byPerson, note: "weeks start on Monday; the last one may be unfinished (partial)" };
}

// ------------------------------------------------------------- client radar
// The clients who need someone now, each with why — lists capped at `limit`.
async function clientRadar(user, { limit = 20 } = {}) {
  const cap = Math.min(60, Math.max(5, Number(limit) || 20));
  const now = Date.now();
  const today = firmNow().date;
  const scope = clientScope(user);
  const money = canSeeFinance(user);
  const person = { select: { username: true, name: true, employee: { select: { name: true } } } };
  const clientSel = { select: { id: true, name: true } };

  const [lateSteps, noNextStep, recentSummaries, contracts] = await Promise.all([
    prisma.clientFollowUp.findMany({
      where: { status: "open", dueAt: { lt: new Date(now - 60 * 60 * 1000) }, client: { archivedAt: null, ...scope } },
      orderBy: { dueAt: "asc" },
      take: cap,
      include: { client: clientSel, assignee: person },
    }),
    prisma.clientCase.findMany({
      where: {
        status: { in: ["consultation", "call_again"] },
        OR: [{ startDate: null }, { startDate: { lt: shiftDate(today, -2) } }],
        client: { archivedAt: null, ...scope, followUps: { none: { status: "open" } }, appointments: { none: { date: { gte: today }, status: "booked" } } },
      },
      orderBy: { updatedAt: "asc" },
      take: cap,
      select: { id: true, status: true, matter: true, startDate: true, updatedAt: true, operator: { select: { name: true } }, client: clientSel },
    }),
    prisma.appointment.findMany({
      where: { summaryAt: { gte: new Date(now - 60 * DAY_MS) }, client: { archivedAt: null, ...scope } },
      orderBy: { summaryAt: "desc" },
      take: 200,
      select: { id: true, date: true, summary: true, client: clientSel, case: { select: { id: true, status: true } } },
    }),
    prisma.clientCase.findMany({
      where: { status: "contract", client: { archivedAt: null, ...scope } },
      take: 400,
      select: {
        id: true,
        matter: true,
        contractDate: true,
        coordinator: { select: { name: true } },
        client: clientSel,
        events: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
        dates: { where: { deletedAt: null, date: { gte: today } }, take: 1, select: { date: true } },
        payments: { select: { amount: true, kind: true, date: true } },
        installments: true,
      },
    }),
  ]);

  // Said "potential" at the consultation, and still not signed a week on.
  const potentialNotSigned = recentSummaries
    .filter((a) => a.summary?.prospect === "potential" && a.case?.status === "consultation" && a.date < shiftDate(today, -7))
    .slice(0, cap)
    .map((a) => ({ clientId: a.client.id, client: a.client.name, consultation: a.date, next: a.summary.next?.kind ?? null, conclusion: short(a.summary.conclusion, 160) }));

  const quietContracts = contracts
    .filter((k) => !k.dates.length && (!k.events[0] || now - k.events[0].createdAt.getTime() > 30 * DAY_MS))
    .slice(0, cap)
    .map((k) => ({ clientId: k.client.id, client: k.client.name, matter: k.matter, coordinator: k.coordinator?.name ?? null, lastActivity: when(k.events[0]?.createdAt) }));

  const result = {
    lateNextSteps: lateSteps.map((f) => ({ clientId: f.client.id, client: f.client.name, kind: f.kind, due: when(f.dueAt), daysLate: Math.floor((now - f.dueAt.getTime()) / DAY_MS), note: short(f.note, 140), who: nameOf(f.assignee) })),
    consultationsWithoutNextStep: noNextStep.map((k) => ({ clientId: k.client.id, client: k.client.name, matter: k.matter, status: k.status, since: k.startDate, operator: k.operator?.name ?? null })),
    potentialNotSigned,
    quietContracts,
  };
  if (money) {
    result.overduePayments = contracts
      .filter((k) => k.installments.length)
      .map((k) => ({ k, s: scheduleOf(k.installments, k.payments, today) }))
      .filter(({ s }) => s.overdue > 0)
      .sort((a, b) => b.s.overdue - a.s.overdue)
      .slice(0, cap)
      .map(({ k, s }) => ({ clientId: k.client.id, client: k.client.name, overdue: s.overdue, since: s.overdueSince, coordinator: k.coordinator?.name ?? null }));
  }
  return result;
}

// ------------------------------------------------------------- why clients are lost
// Consultations that didn't continue in a period (default: the last 90
// days): how many, why, by whom, about what — and what was written, against
// the contracts signed in the same time.
async function lostReasons(user, { from, to } = {}) {
  const today = firmNow().date;
  const start = isValidDate(from) ? from : shiftDate(today, -90);
  const end = isValidDate(to) ? to : today;
  const scope = clientScope(user);
  const [lost, signed, notPotential] = await Promise.all([
    prisma.clientCase.findMany({
      where: { status: "declined", closedDate: { gte: start, lte: end }, client: scope },
      select: { matter: true, lostReason: true, lostNote: true, closedDate: true, operator: { select: { name: true } }, client: { select: { name: true } } },
      take: 500,
    }),
    prisma.clientCase.count({ where: { contractDate: { gte: start, lte: end }, client: scope } }),
    prisma.appointment.findMany({
      where: { date: { gte: start, lte: end }, summaryAt: { not: null }, client: scope },
      select: { summary: true, matter: true },
      take: 500,
    }),
  ]);
  const count = (list, key) => {
    const m = new Map();
    for (const x of list) m.set(key(x) || "—", (m.get(key(x) || "—") || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ [k]: n }));
  };
  const words = notPotential.filter((a) => a.summary?.prospect === "not_potential");
  return {
    period: { from: start, to: end },
    lost: lost.length,
    contractsSigned: signed,
    byReason: count(lost, (k) => k.lostReason),
    byOperator: count(lost, (k) => k.operator?.name).slice(0, 12),
    byMatter: count(lost, (k) => (k.matter || "").toLowerCase().trim().slice(0, 40)).slice(0, 15),
    notes: lost
      .filter((k) => k.lostNote)
      .slice(0, 40)
      .map((k) => ({ reason: k.lostReason, matter: k.matter, note: short(k.lostNote, 200) })),
    lawyersSaid: words.slice(0, 40).map((a) => ({ matter: a.matter, reason: a.summary.lostReason, conclusion: short(a.summary.conclusion, 220) })),
  };
}

module.exports = { trends, clientRadar, lostReasons };
