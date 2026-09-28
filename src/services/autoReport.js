const prisma = require("../lib/prisma");
const { firmDate, firmDayRange, isValidDate, shiftDate } = require("../lib/firmTime");

// Automatic daily reports. For people with Employee.autoReport on (call-center
// staff), the day's report isn't a form they fill in: it's worked out from
// what they did — their calls, the appointments they booked, the clients
// they added, their consultations and contracts, the payments they recorded.
// Worked out when asked for, never stored, so calls that sync late still
// count and nothing goes stale.

const REACHED = ["called_back", "client_called_again", "handled"];
const NEEDS_CALLBACK = ["attempted", "pending"];
// The longest span one request may ask for.
const MAX_DAYS = 62;

function blankDay(date) {
  return {
    date,
    calls: { total: 0, incoming: 0, outgoing: 0, answered: 0, missed: 0, reached: 0, needsCallback: 0, talkSeconds: 0 },
    booked: 0,
    newClients: 0,
    consultations: 0,
    contracts: 0,
    payments: { count: 0, amount: 0 },
  };
}

// Every date from `from` to `to` ("YYYY-MM-DD", inclusive), oldest first.
function datesBetween(from, to) {
  const dates = [];
  for (let d = from; d <= to && dates.length <= MAX_DAYS; d = shiftDate(d, 1)) dates.push(d);
  return dates;
}

// "from"/"to" checked: valid dates, in order, not in the future, at most
// MAX_DAYS apart. Returns an error message or null.
function checkRange(from, to, today = firmDate()) {
  if (!isValidDate(from) || !isValidDate(to)) return "invalid date";
  if (from > to) return "from is after to";
  if (to > today) return "date is in the future";
  if (datesBetween(from, to).length > MAX_DAYS) return `at most ${MAX_DAYS} days`;
  return null;
}

// employee: { id, userId, collectCalls }. One report per date, oldest first.
// People whose calls aren't collected get `calls: null` (nothing to count).
async function autoReportDays(employee, from, to) {
  const dates = datesBetween(from, to);
  const days = new Map(dates.map((d) => [d, blankDay(d)]));
  // Each day's bounds in the firm's timezone, to put a moment on its day.
  const bounds = dates.map((d) => ({ day: days.get(d), ...firmDayRange(d) }));
  const start = bounds[0].from;
  const end = bounds[bounds.length - 1].to;
  const created = { gte: new Date(start), lte: new Date(end) };
  const userId = employee.userId ?? -1;
  const dayOf = (moment) => {
    const ms = moment instanceof Date ? moment.getTime() : moment;
    return bounds.find((b) => ms >= b.from && ms <= b.to)?.day;
  };

  const [calls, booked, clients, consultations, contracts, payments] = await Promise.all([
    employee.collectCalls
      ? prisma.callLog.findMany({
          where: { employeeId: employee.id, callTimestampMs: { gte: BigInt(start), lte: BigInt(end) } },
          select: { callTimestampMs: true, callType: true, missed: true, durationSeconds: true, followUp: true },
        })
      : [],
    prisma.appointment.findMany({ where: { bookedById: userId, createdAt: created }, select: { createdAt: true } }),
    prisma.client.findMany({ where: { createdById: userId, createdAt: created }, select: { createdAt: true } }),
    prisma.clientCase.findMany({ where: { operatorId: employee.id, consultationDate: { gte: from, lte: to } }, select: { consultationDate: true } }),
    prisma.clientCase.findMany({ where: { operatorId: employee.id, contractDate: { gte: from, lte: to } }, select: { contractDate: true } }),
    prisma.payment.findMany({ where: { recordedById: userId, date: { gte: from, lte: to } }, select: { date: true, amount: true } }),
  ]);

  for (const c of calls) {
    const day = dayOf(Number(c.callTimestampMs));
    if (!day) continue;
    const s = day.calls;
    s.total += 1;
    s.talkSeconds += c.durationSeconds || 0;
    if (c.missed) {
      s.missed += 1;
      if (REACHED.includes(c.followUp)) s.reached += 1;
      if (NEEDS_CALLBACK.includes(c.followUp)) s.needsCallback += 1;
    } else {
      s.answered += 1;
      if (c.callType === "incoming") s.incoming += 1;
      if (c.callType === "outgoing") s.outgoing += 1;
    }
  }
  for (const a of booked) {
    const day = dayOf(a.createdAt);
    if (day) day.booked += 1;
  }
  for (const c of clients) {
    const day = dayOf(c.createdAt);
    if (day) day.newClients += 1;
  }
  for (const k of consultations) if (days.has(k.consultationDate)) days.get(k.consultationDate).consultations += 1;
  for (const k of contracts) if (days.has(k.contractDate)) days.get(k.contractDate).contracts += 1;
  for (const p of payments) {
    const day = days.get(p.date);
    if (!day) continue;
    day.payments.count += 1;
    day.payments.amount += p.amount;
  }

  const list = [...days.values()];
  if (!employee.collectCalls) for (const day of list) day.calls = null;
  return list;
}

// Several people's reports (or several days) added up — the team's totals.
function addUp(reports) {
  const total = blankDay(null);
  let withCalls = false;
  for (const r of reports) {
    if (r.calls) {
      withCalls = true;
      for (const key of Object.keys(total.calls)) total.calls[key] += r.calls[key];
    }
    for (const key of ["booked", "newClients", "consultations", "contracts"]) total[key] += r[key];
    total.payments.count += r.payments.count;
    total.payments.amount += r.payments.amount;
  }
  if (!withCalls) total.calls = null;
  delete total.date;
  return total;
}

module.exports = { autoReportDays, addUp, checkRange, MAX_DAYS };
