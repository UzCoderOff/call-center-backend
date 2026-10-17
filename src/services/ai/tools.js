const prisma = require("../../lib/prisma");
const env = require("../../config/env");
const { isManager } = require("../../middleware/auth");
const { canSeeFinance } = require("../../lib/finance");
const { firmNow, firmDayRange, isValidDate, shiftDate } = require("../../lib/firmTime");
const { jobsOf, isCallCenter } = require("../../lib/jobs");
const { hasCalls } = require("../../lib/calling");
const { clientScope } = require("../../lib/clientAccess");
const { clientIndex } = require("../../lib/clientsDb");
const { computeCallStats } = require("../stats");
const { countedCallsWhere } = require("../../lib/calling");
const { computeFunnel } = require("../funnel");
const { DEFAULT_FEE } = require("../consultationFee");
const { monthPerformance } = require("../performance");
const { scheduleOf } = require("../installments");
const cl = require("../clients");

// What Ledger AI may look up — read-only, each one the same data (and the
// same access rules) as the portal page it mirrors. Only the boss and the
// developer have Ledger AI; contract money only with Moliya (canSeeFinance).
// Every answer is plain JSON (no BigInt), lists capped, so a question costs
// cents, not dollars.

const MAX_LIST = 25;

// ------------------------------------------------------------- helpers

const nameOf = (u) => u?.employee?.name || u?.name || u?.username || null;

// "2026-10-04 14:05" in the firm's time.
const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: env.firmTimezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const when = (value) => (value == null ? null : stamp.format(new Date(typeof value === "bigint" ? Number(value) : value)));
const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

function bad(message) {
  const err = new Error(message);
  err.toolError = true;
  return err;
}

// from/to "YYYY-MM-DD" (firm days); default: this month so far.
function period(args) {
  const today = firmNow().date;
  const from = args.from || `${today.slice(0, 7)}-01`;
  const to = args.to || today;
  if (!isValidDate(from) || !isValidDate(to)) throw bad("from/to must be YYYY-MM-DD");
  if (from > to) throw bad("from is after to");
  return { from, to, fromMs: firmDayRange(from).from, toMs: firmDayRange(to).to };
}

function month(args) {
  const m = args.month || firmNow().date.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw bad("month must be YYYY-MM");
  return m;
}

// Names typed any way (Latin/Cyrillic, part of a name) -> matching people.
const loose = (s) => cl.searchable(s || "");
function matches(name, query) {
  const words = loose(query).split(" ").filter(Boolean);
  const hay = loose(name);
  return words.length > 0 && words.every((w) => hay.includes(w));
}

async function employeesNamed(query) {
  const all = await prisma.employee.findMany({ select: { id: true, name: true, userId: true, active: true } });
  const found = all.filter((e) => matches(e.name, query));
  if (found.length === 0) throw bad(`no employee matches "${query}"`);
  return found;
}

async function usersNamed(query) {
  const all = await prisma.user.findMany({ select: { id: true, username: true, name: true, role: true, employee: { select: { name: true } } } });
  const found = all.filter((u) => matches(nameOf(u), query) || matches(u.username, query));
  if (found.length === 0) throw bad(`no person matches "${query}"`);
  return found;
}

// Arrays longer than `n` are cut (with how many there were) — nested too.
function cap(value, n = 12, depth = 0) {
  if (Array.isArray(value)) {
    const items = value.slice(0, n).map((v) => cap(v, n, depth + 1));
    return value.length > n ? { first: items, total: value.length } : items;
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    if (depth > 6) return undefined;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const c = cap(v, n, depth + 1);
      if (c !== undefined && c !== null) out[k] = c;
    }
    return out;
  }
  return typeof value === "bigint" ? Number(value) : value;
}

function callNumbers(s) {
  return {
    calls: s.totalCalls,
    answered: s.answeredCalls,
    missed: s.missedCalls,
    talkMinutes: Math.round(s.talkSeconds / 60),
    missedCalledBackOrReached: s.followUp.reached,
    missedNotCalledBack: s.followUp.needsCallback,
    medianCallbackMinutes: s.followUp.medianCallbackSec == null ? null : Math.round(s.followUp.medianCallbackSec / 60),
  };
}

// ------------------------------------------------------------- the tools

const TOOLS = [
  {
    name: "call_stats",
    description: "Phone calls in a period: totals and per employee (calls, answered, missed, talk minutes, missed calls not called back, median call-back time). Default period: this month so far.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        employee: { type: "string", description: "part of an employee's name, to see only them" },
      },
    },
    async run(args) {
      const p = period(args);
      const people = args.employee ? await employeesNamed(args.employee) : null;
      const { totals, byEmployee } = await computeCallStats({ employeeIds: people ? people.map((e) => e.id) : null, from: p.fromMs, to: p.toMs });
      const names = new Map((await prisma.employee.findMany({ select: { id: true, name: true } })).map((e) => [e.id, e.name]));
      const rows = [...byEmployee.entries()]
        .map(([id, s]) => ({ employee: names.get(id) || `#${id}`, ...callNumbers(s) }))
        .filter((r) => r.calls > 0)
        .sort((a, b) => b.calls - a.calls);
      return { period: { from: p.from, to: p.to }, totals: callNumbers(totals), byEmployee: rows };
    },
  },
  {
    name: "missed_calls_waiting",
    description: "Missed calls from the last 7 days that nobody has called back yet (who missed it, when, the number, the client if known).",
    parameters: { type: "object", properties: { employee: { type: "string", description: "part of an employee's name" } } },
    async run(args) {
      const people = args.employee ? await employeesNamed(args.employee) : null;
      const where = {
        missed: true,
        followUp: { in: ["pending", "attempted"] },
        callTimestampMs: { gte: BigInt(Date.now() - 7 * 24 * 3600 * 1000) },
        ...(people ? { employeeId: { in: people.map((e) => e.id) } } : {}),
        ...countedCallsWhere(),
      };
      const [total, calls] = await Promise.all([
        prisma.callLog.count({ where }),
        prisma.callLog.findMany({ where, orderBy: { callTimestampMs: "desc" }, take: MAX_LIST, include: { employee: { select: { name: true } } } }),
      ]);
      const clients = await clientIndex(prisma, calls.map((c) => c.phoneKey).filter(Boolean));
      return {
        total,
        calls: calls.map((c) => ({
          when: when(c.callTimestampMs),
          number: c.phoneNumber,
          missedBy: c.employee.name,
          triedToCallBack: c.followUp === "attempted",
          client: c.phoneKey ? clients.get(c.phoneKey)?.name || null : null,
        })),
      };
    },
  },
  {
    name: "staff_performance",
    description:
      "Natijalar for a month, per employee: calls; consultations (= the consultations they booked in the calendar, not cancelled, counted on their own day so far — a booking and a consultation are the same thing) vs. their target, with came / noShow / unmarked / today / upcoming (later this month, not counted yet) / cancelled; contracts vs. target; conversion (clients with a consultation this month who signed since); reports sent/missing, tasks open/overdue, late call-back strikes, clients added" +
      " (and money brought in, when the asker may see finance). Default: this month.",
    parameters: {
      type: "object",
      properties: { month: { type: "string", description: "YYYY-MM" }, employee: { type: "string", description: "part of an employee's name" } },
    },
    async run(args, user) {
      const m = month(args);
      const range = { gte: `${m}-01`, lte: `${m}-31` };
      const { EMPLOYEE_SELECT } = require("../../routes/performance");
      let employees = await prisma.employee.findMany({
        where: {
          OR: [
            { active: true },
            { cases: { some: { contractDate: range } } },
            { user: { bookedAppointments: { some: { date: range, status: { not: "cancelled" } } } } },
          ],
        },
        select: EMPLOYEE_SELECT,
        orderBy: { name: "asc" },
      });
      if (args.employee) employees = employees.filter((e) => matches(e.name, args.employee));
      if (employees.length === 0) throw bad("nobody matches");
      const finance = canSeeFinance(user);
      const data = await monthPerformance({ month: m, employees, finance });
      return {
        month: data.month,
        workDays: data.workDays,
        workDaysSoFar: data.workDaysSoFar,
        people: data.rows.map((r) => ({
          name: r.employee.name,
          active: r.employee.active,
          position: r.employee.position?.name || r.employee.position || null,
          jobs: r.work?.jobs,
          calls: r.calls && { total: r.calls.total, answered: r.calls.answered, missed: r.calls.missed, needsCallback: r.calls.needsCallback, answerRate: r.calls.answerRate },
          consultations: r.consultations,
          contracts: r.contracts,
          conversionRate: r.conversion?.rate ?? null,
          reports: r.reports && { due: r.reports.due, sent: r.reports.sent, missing: r.reports.missing?.length ?? 0 },
          tasks: r.tasks,
          coordinator: r.coordinator ? { cases: r.coordinator.cases, finished: r.coordinator.finished, overdueCases: r.coordinator.overdueCases } : undefined,
          lateCallBackStrikes: r.strikes?.count ?? null,
          clientsAdded: r.clientsAdded,
          money: finance && r.money ? { broughtIn: r.money.brought?.total ?? r.money.brought, taken: r.money.taken?.total } : undefined,
        })),
      };
    },
  },
  {
    name: "call_funnel",
    description:
      "From calls to consultations to contracts, counted by phone numbers (not calls), in a period — for the whole call center, or one operator (employee; then the numbers their phone talked to). numbers, new vs returning, reached (someone talked to them within a week), lost (NOBODY talked to them: missed and never reached — not a recorded reason), booked a consultation, came, signed; outcomes = why new numbers they talked to didn't book (the reason the operator tapped), outcomeMissing = such numbers with no reason yet; lostReasons = why consultations didn't continue (cases closed as declined).",
    parameters: {
      type: "object",
      properties: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" }, employee: { type: "string", description: "part of an operator's name, for only them" } },
    },
    async run(args) {
      const p = period(args);
      const staff = await prisma.employee.findMany({ select: { id: true, name: true, job: true, extraJobs: true } });
      let ids = staff.filter((e) => isCallCenter(e)).map((e) => e.id);
      let who = null;
      if (args.employee) {
        const found = staff.filter((e) => matches(e.name, args.employee));
        if (found.length !== 1) return { error: found.length ? `several match: ${found.map((e) => e.name).join(", ")}` : `no employee is called "${args.employee}"` };
        ids = [found[0].id];
        who = found[0].name;
      }
      const f = await computeFunnel({ employeeIds: ids.length ? ids : null, from: p.fromMs, to: p.toMs, fee: DEFAULT_FEE });
      return cap({ period: { from: p.from, to: p.to }, employee: who, ...f, now: undefined }, 10);
    },
  },
  {
    name: "finance_month",
    finance: true,
    description:
      "The firm's money for a month (Moliya page): income (client payments + report money), expenses, net, contracts signed and their value, what clients still owe (overdue, due soon, who owes most), consultations paid/unpaid, per lawyer, 6-month trend. Default: this month.",
    parameters: { type: "object", properties: { month: { type: "string", description: "YYYY-MM" } } },
    async run(args, user) {
      const { financeData } = require("../../routes/finance");
      const d = await financeData(user, month(args));
      return cap(
        {
          month: d.month,
          today: d.today,
          summary: d.summary,
          sources: d.sources && { clients: d.sources.clients, methods: d.sources.methods, people: d.sources.people },
          consultations: d.consultations,
          contracts: d.contracts,
          owed: d.owed && { total: d.owed.total, clients: d.owed.clients, plan: d.owed.plan, aging: d.owed.aging, top: d.owed.top, overdueList: d.owed.overdueList },
          lawyers: d.lawyers,
          trend: d.trend,
        },
        10
      );
    },
  },
  {
    name: "search_clients",
    description:
      "Find clients by name, phone or case number (any spelling, Latin or Cyrillic), or list them by a filter: debt (owe money), active (open cases), callToday (to call today), stale (consultations that went nowhere for 30+ days), archived. Returns up to 15 with their cases.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "name, phone or case number" },
        filter: { type: "string", enum: ["debt", "active", "callToday", "stale", "archived"] },
        status: { type: "string", enum: cl.STATUSES },
      },
    },
    async run(args, user) {
      if (args.filter === "debt" && !canSeeFinance(user)) throw bad("finance is not available to this person");
      const { listQuery } = require("../../routes/clients");
      const { where, orderBy } = await listQuery({ q: args.query, filter: args.filter, status: args.status }, user);
      const money = canSeeFinance(user);
      const [total, rows] = await Promise.all([
        prisma.client.count({ where }),
        prisma.client.findMany({
          where,
          orderBy,
          take: 15,
          include: {
            phones: { select: { phone: true } },
            cases: {
              include: {
                operator: { select: { name: true } },
                coordinator: { select: { name: true } },
                lawyerAccount: { select: { name: true, username: true, employee: { select: { name: true } } } },
                payments: { select: { amount: true, kind: true } },
              },
            },
          },
        }),
      ]);
      return {
        total,
        clients: rows.map((c) => ({
          id: c.id,
          name: c.name,
          city: c.city,
          phones: c.phones.map((p) => p.phone),
          nextCall: when(c.nextCallAt),
          cases: c.cases.map((k) => caseLine(k, money)),
        })),
      };
    },
  },
  {
    name: "client_details",
    description: "Everything about one client (use the id from search_clients): cases (status, stage, lawyer, operator, coordinator, dates, money and payment schedule), open next steps, appointments, recent calls, latest notes.",
    parameters: { type: "object", properties: { client_id: { type: "integer" } }, required: ["client_id"] },
    async run(args, user) {
      const id = Number(args.client_id);
      const money = canSeeFinance(user);
      const c = await prisma.client.findFirst({
        where: { AND: [{ id }, clientScope(user)] },
        include: {
          phones: { select: { phone: true, phoneKey: true } },
          cases: {
            include: {
              operator: { select: { name: true } },
              coordinator: { select: { name: true } },
              lawyerAccount: { select: { name: true, username: true, employee: { select: { name: true } } } },
              payments: { select: { amount: true, kind: true, date: true, method: true } },
              installments: true,
            },
          },
          followUps: { where: { status: "open" }, orderBy: { dueAt: "asc" }, include: { assignee: { select: { name: true, username: true, employee: { select: { name: true } } } } } },
          appointments: { orderBy: [{ date: "desc" }, { start: "desc" }], take: 6, include: { calendar: { select: { name: true } } } },
          events: { where: { deletedAt: null }, orderBy: { createdAt: "desc" }, take: 8 },
        },
      });
      if (!c) throw bad("no such client");
      const keys = c.phones.map((p) => p.phoneKey).filter(Boolean);
      const calls = keys.length
        ? await prisma.callLog.findMany({ where: { phoneKey: { in: keys } }, orderBy: { callTimestampMs: "desc" }, take: 8, include: { employee: { select: { name: true } } } })
        : [];
      const today = firmNow().date;
      return {
        id: c.id,
        name: c.name,
        city: c.city,
        source: c.source,
        phones: c.phones.map((p) => p.phone),
        archived: Boolean(c.archivedAt),
        nextCall: c.nextCallAt ? { at: when(c.nextCallAt), note: c.nextCallNote } : null,
        cases: c.cases.map((k) => {
          const line = caseLine(k, money);
          if (money && k.installments.length) {
            const s = scheduleOf(k.installments, k.payments, today);
            line.schedule = { overdue: s.overdue, overdueSince: s.overdueSince, next: s.next };
          }
          if (money) line.payments = k.payments.slice(-6).map((p) => ({ date: p.date, amount: p.amount, kind: p.kind, method: p.method }));
          return line;
        }),
        nextSteps: c.followUps.map((f) => ({ kind: f.kind, due: when(f.dueAt), note: f.note, who: nameOf(f.assignee) })),
        appointments: c.appointments.map((a) => ({
          date: a.date,
          time: hhmm(a.start),
          lawyer: a.calendar.name,
          status: a.status,
          format: a.format,
          matter: a.matter,
          // The consultation summary ("suhbat yakuni"), when written.
          summary: a.summary
            ? { prospect: a.summary.prospect, next: a.summary.next ? { kind: a.summary.next.kind, due: when(a.summary.next.dueAt) } : null, lostReason: a.summary.lostReason, topic: a.summary.topic, advice: a.summary.advice, conclusion: a.summary.conclusion }
            : null,
        })),
        recentCalls: calls.map((k) => ({ when: when(k.callTimestampMs), type: k.callType, minutes: Math.round(k.durationSeconds / 60), employee: k.employee.name })),
        latestNotes: c.events.map((e) => ({ at: when(e.createdAt), kind: e.kind, text: String(e.text).slice(0, 300) })),
      };
    },
  },
  {
    name: "appointments",
    description: "Consultations (= bookings in the consultation calendar) in a date range (default: today): date, time, lawyer, client, matter, office/online, status (booked = not marked yet, attended, no_show, cancelled), who booked it — plus counts by status. consultations = the ones that count (all but cancelled).",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        lawyer: { type: "string", description: "part of the lawyer's (calendar's) name" },
      },
    },
    async run(args) {
      const today = firmNow().date;
      const from = args.from || today;
      const to = args.to || from;
      if (!isValidDate(from) || !isValidDate(to)) throw bad("from/to must be YYYY-MM-DD");
      if (shiftDate(from, 62) < to) throw bad("at most 62 days at a time");
      let rows = await prisma.appointment.findMany({
        where: { date: { gte: from, lte: to } },
        orderBy: [{ date: "asc" }, { start: "asc" }],
        include: { calendar: { select: { name: true } }, bookedBy: { select: { name: true, username: true, employee: { select: { name: true } } } } },
      });
      if (args.lawyer) rows = rows.filter((a) => matches(a.calendar.name, args.lawyer));
      const byStatus = {};
      for (const a of rows) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
      return {
        from,
        to,
        total: rows.length,
        consultations: rows.filter((a) => a.status !== "cancelled").length,
        byStatus,
        list: rows.slice(0, 40).map((a) => ({
          date: a.date,
          time: hhmm(a.start),
          lawyer: a.calendar.name,
          client: a.clientName,
          matter: a.matter,
          format: a.format,
          status: a.status,
          bookedBy: nameOf(a.bookedBy),
        })),
      };
    },
  },
  {
    name: "tasks",
    description:
      "Tasks given to staff: open ones (or only overdue), or those done in the last 7 days — id, title, notes, who it's for, due, client, who gave it (Ledger AI for the ones you prepared), and the person's written answer (needsAnswer: they were asked to write one).",
    parameters: {
      type: "object",
      properties: {
        state: { type: "string", enum: ["open", "overdue", "done_recently"], description: "default: open" },
        person: { type: "string", description: "part of the assignee's name" },
      },
    },
    async run(args) {
      const state = args.state || "open";
      const where =
        state === "done_recently"
          ? { doneAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) } }
          : { doneAt: null, ...(state === "overdue" ? { dueAt: { lt: new Date() } } : {}) };
      if (args.person) where.assigneeId = { in: (await usersNamed(args.person)).map((u) => u.id) };
      const person = { select: { name: true, username: true, employee: { select: { name: true } } } };
      const [total, rows] = await Promise.all([
        prisma.task.count({ where }),
        prisma.task.findMany({ where, orderBy: { dueAt: "asc" }, take: 30, include: { assignee: person, createdBy: person, client: { select: { name: true } } } }),
      ]);
      const now = Date.now();
      return {
        state,
        total,
        tasks: rows.map((t) => ({
          id: t.id,
          title: t.title,
          notes: t.notes ? t.notes.slice(0, 600) : null,
          for: nameOf(t.assignee),
          due: when(t.dueAt),
          overdue: !t.doneAt && t.dueAt.getTime() < now,
          done: when(t.doneAt),
          client: t.client?.name || null,
          givenBy: t.viaAi ? `Ledger AI (${nameOf(t.createdBy)} tasdiqlagan)` : nameOf(t.createdBy),
          needsAnswer: t.needsAnswer,
          answer: t.answer ? t.answer.slice(0, 1500) : null,
          answered: when(t.answeredAt),
        })),
      };
    },
  },
  {
    name: "next_steps",
    description: "Clients' open next steps (call, decision, meeting, documents, payment…): overdue ones and those due today, with who is responsible.",
    parameters: { type: "object", properties: { person: { type: "string", description: "part of the responsible person's name" } } },
    async run(args) {
      const where = { status: "open", dueAt: { lte: new Date(firmDayRange(firmNow().date).to) }, client: { archivedAt: null } };
      if (args.person) where.assigneeId = { in: (await usersNamed(args.person)).map((u) => u.id) };
      const [total, rows] = await Promise.all([
        prisma.clientFollowUp.count({ where }),
        prisma.clientFollowUp.findMany({
          where,
          orderBy: { dueAt: "asc" },
          take: 30,
          include: { client: { select: { id: true, name: true } }, assignee: { select: { name: true, username: true, employee: { select: { name: true } } } } },
        }),
      ]);
      const now = Date.now();
      return {
        total,
        steps: rows.map((f) => ({ client: f.client.name, clientId: f.client.id, kind: f.kind, due: when(f.dueAt), overdue: f.dueAt.getTime() < now, note: f.note, who: nameOf(f.assignee) })),
      };
    },
  },
  {
    name: "trends",
    description:
      "Week by week (Monday-Sunday) for the last N weeks: calls, answered, missed, missed not called back, new matters, consultations (calendar entries, not cancelled — the same thing as bookings), came, no-shows, contracts, lost ones, consultation fees (and other income with Moliya) — plus each person's consultations (the ones they booked) and contracts per week. Use it for trajectories: what is rising or falling, who is improving or slipping.",
    parameters: {
      type: "object",
      properties: { weeks: { type: "integer", description: "2-26, default 8" }, employee: { type: "string", description: "part of an employee's name, to see only them" } },
    },
    async run(args, user) {
      const people = args.employee ? await employeesNamed(args.employee) : null;
      return require("./insights").trends(user, { weeks: args.weeks, employeeIds: people ? people.map((e) => e.id) : null });
    },
  },
  {
    name: "client_radar",
    description:
      "Clients who need attention now, each with why: next steps that are late, open consultations with no next step, clients the lawyer called potential who still haven't signed after a week, contracts with no activity for 30 days, and (with Moliya) overdue payments. Use it to suggest who to call and what to do.",
    parameters: { type: "object", properties: { limit: { type: "integer", description: "per list, default 20" } } },
    async run(args, user) {
      return require("./insights").clientRadar(user, { limit: args.limit });
    },
  },
  {
    name: "lost_reasons",
    description:
      "Why consultations didn't continue in a period (default: last 90 days): how many vs contracts signed, by reason, by operator, by matter, the notes written, and what lawyers wrote when they judged a client not potential.",
    parameters: { type: "object", properties: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" } } },
    async run(args, user) {
      return require("./insights").lostReasons(user, { from: args.from, to: args.to });
    },
  },
  {
    name: "daily_reports",
    description:
      "Staff daily report forms for one day (default today): who sent theirs, who hasn't yet (people on a day off aren't expected), and what each one wrote — every question with its answer. Optionally only one person.",
    parameters: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD" }, employee: { type: "string", description: "part of an employee's name" } },
    },
    async run(args) {
      const { asksForm } = require("../autoReport");
      const { workingDates } = require("../workdays");
      const date = args.date || firmNow().date;
      if (!isValidDate(date)) throw bad("date must be YYYY-MM-DD");
      let employees = await prisma.employee.findMany({
        where: { active: true, reportTemplateId: { not: null } },
        select: { id: true, name: true, autoReport: true, alsoForm: true, reportTemplateId: true, workDays: true, holidaysOff: true, reportTemplate: { select: { id: true, name: true, active: true } } },
        orderBy: { name: "asc" },
      });
      employees = employees.filter((e) => asksForm(e) && e.reportTemplate?.active);
      if (args.employee) {
        employees = employees.filter((e) => matches(e.name, args.employee));
        if (employees.length === 0) throw bad(`nobody with a report form matches "${args.employee}"`);
      }
      const [reports, days] = await Promise.all([
        prisma.report.findMany({ where: { date, employeeId: { in: employees.map((e) => e.id) } } }),
        workingDates(employees, date, date),
      ]);
      const answerText = (field, value) => {
        if (value == null || value === "") return null;
        if (field.type === "yesno") return value ? "ha" : "yoʻq";
        if (field.type === "checklist") return Array.isArray(value) ? value.join(", ") : String(value);
        if (field.type === "table") {
          const cols = field.columns || [];
          return (Array.isArray(value) ? value : [])
            .slice(0, 15)
            .map((row) => cols.map((c) => `${c.label}: ${row?.[c.id] ?? "—"}`).join("; "))
            .join(" | ");
        }
        return String(value).slice(0, 600);
      };
      const people = employees.map((e) => {
        const report = reports.find((r) => r.employeeId === e.id && r.templateId === e.reportTemplateId);
        const off = days.byEmployee.get(e.id)?.off[0] || null;
        if (!report) return { name: e.name, form: e.reportTemplate.name, sent: false, dayOff: off ? off.reason || true : false };
        const fields = Array.isArray(report.fields) ? report.fields : [];
        const answers = report.answers && typeof report.answers === "object" ? report.answers : {};
        return {
          name: e.name,
          form: e.reportTemplate.name,
          sent: true,
          sentAt: when(report.submittedAt),
          answers: fields.map((f) => ({ q: f.label, a: answerText(f, answers[f.id]) })).filter((x) => x.a != null),
        };
      });
      const expected = people.filter((p) => p.sent || !p.dayOff);
      return { date, expected: expected.length, sent: people.filter((p) => p.sent).length, notSent: expected.filter((p) => !p.sent).map((p) => p.name), people };
    },
  },
  {
    name: "staff",
    description: "Who works at the firm: employees (position, office, jobs, phone ID, whether their calls are in Ledger, active) and lawyers' accounts.",
    parameters: { type: "object", properties: { include_inactive: { type: "boolean" } } },
    async run(args) {
      const [employees, lawyers] = await Promise.all([
        prisma.employee.findMany({
          where: args.include_inactive ? {} : { active: true },
          orderBy: { name: "asc" },
          include: { position: { select: { name: true } }, office: { select: { name: true } }, pbx: { select: { ext: true } } },
        }),
        prisma.user.findMany({ where: { role: "LAWYER" }, select: { name: true, username: true, employee: { select: { name: true } } } }),
      ]);
      return {
        employees: employees.map((e) => ({
          name: e.name,
          active: e.active,
          position: e.position?.name || null,
          office: e.office?.name || null,
          jobs: jobsOf(e),
          phoneId: e.pbx?.ext ?? null,
          callsInLedger: hasCalls(e),
          workKind: e.workKind,
        })),
        lawyers: lawyers.map(nameOf),
      };
    },
  },
];

// One case, as the tools show it — money only with Moliya.
function caseLine(k, money) {
  const line = {
    caseId: k.id,
    matter: k.matter,
    details: k.details ? String(k.details).slice(0, 800) : null,
    number: k.number,
    status: k.status,
    legalStage: k.legalStage,
    lawyer: nameOf(k.lawyerAccount) || k.lawyer,
    operator: k.operator?.name || null,
    coordinator: k.coordinator?.name || null,
    consultationDate: k.consultationDate,
    contractDate: k.contractDate,
    closedDate: k.closedDate,
    lostReason: k.lostReason,
  };
  if (money && k.contractAmount) {
    const s = cl.paymentSummary(k.contractAmount, k.payments || []);
    Object.assign(line, { contractAmount: k.contractAmount, paid: s.paid, remaining: s.remaining });
  }
  return line;
}

const allowed = (tool, user) => isManager(user) && (!tool.finance || canSeeFinance(user));

// For OpenAI: the functions this person may use.
const definitions = (user) => TOOLS.filter((t) => allowed(t, user)).map(({ name, description, parameters }) => ({ name, description, parameters }));

async function run(name, args, user) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool || !allowed(tool, user)) return { error: `unknown tool ${name}` };
  try {
    return await tool.run(args || {}, user);
  } catch (err) {
    if (err.toolError || err.status === 400) return { error: err.message };
    throw err;
  }
}

module.exports = { definitions, run, TOOLS, cap, matches };
