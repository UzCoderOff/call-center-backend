const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isManager, isLawyer } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { firmNow, firmDayRange, shiftDate } = require("../lib/firmTime");
const { phoneKey } = require("../lib/phone");
const { refreshSearch, clientsByPhoneKeys } = require("../lib/clientsDb");
const cl = require("../services/clients");
const importer = require("../services/clientImport");
const { buildXlsx } = require("../lib/xlsx");
const { lawyerAccounts, lawyerById } = require("../lib/lawyers");
const { canSeeFinance, canSeeCaseMoney, financeForbidden, caseWithoutMoney, isConsultation, CONSULTATION } = require("../lib/finance");
const { CONTRACT_STATUSES, clientScope, workScope, ownCaseWhere, caseRole, clientLevel, requireClientAccess, accessibleClientIds, clientIndexFor } = require("../lib/clientAccess");
const { isCoordinator } = require("../lib/jobs");
const history = require("../services/caseHistory");
const { syncNextCall, FOLLOW_UP_INCLUDE } = require("../services/clientFollowUps");
const { events: bus } = require("../lib/events");
const { linkConsultationFees } = require("../services/consultationFee");
const { scheduleOf, normalizeSchedule } = require("../services/installments");
const env = require("../config/env");

// The clients database (replaces the firm's Excel CRM).
//
//   /api/clients                 list + search; create
//   /api/clients/:id             one client with everything about them
//   /api/clients/:id/cases       add a case        /api/client-cases/:id  change one
//   /api/clients/:id/payments    add a payment     /api/client-payments/:id  delete
//   /api/clients/:id/notes       add a note        /api/client-notes/:id  delete
//   /api/clients/:id/links       connect clients   /api/client-links/:id  disconnect
//   /api/clients/targets         operators' monthly consultations/contracts
//   /api/clients/import          add many from a spreadsheet (managers)
//   /api/clients/export          the list as an Excel file (managers)
//   DELETE /api/clients/:id      archive (hidden, kept, restorable)  ·  POST …/restore
//   POST /api/clients/:id/merge  fold a duplicate into this client (managers)
//
// Who: managers, and staff who deal with clients — call-center staff, anyone
// who books appointments, coordinators — but staff only see THEIR clients
// (src/lib/clientAccess.js): an operator their consultations, and once the
// client signs only a "result" (name, number, dates); a coordinator the
// cases assigned to them, money included; a lawyer (LAWYER account) the
// cases assigned to them. Archiving, merging, deleting cases/payments,
// importing and exporting: managers only — each recorded in the audit log.
//
// A case's history: its stages with dates (CaseStage) and its key dates
// (CaseDate) — routes/caseWork.js — and every change on the timeline.
//
// Contract money — contract amounts, contract payments, debts — only for the
// DEVELOPER and accounts with the "Moliya" switch (src/lib/finance.js):
// everyone else gets none of it in any answer, and a contract amount they
// send is ignored (so editing a case they can't see the amount of never
// erases it). The consultation fee is the exception: staff see it and record
// it (they check it before booking the client in).

function canUseClients(user) {
  return isManager(user) || isLawyer(user) || Boolean(user.employee?.collectCalls || user.employee?.calendarAccess === "book" || isCoordinator(user.employee));
}
function gate(req, res, next) {
  if (!canUseClients(req.user)) return res.status(403).json({ error: "forbidden" });
  next();
}
// What a lawyer may do here; everything else is closed to them.
function lawyerGate(req, res, next) {
  if (!isLawyer(req.user)) return next();
  const allowed = (req.method === "GET" && /^\/(\d+)?$/.test(req.path)) || (req.method === "POST" && /^\/\d+\/(notes|follow-ups|files\/uploads)$/.test(req.path));
  if (!allowed) return res.status(403).json({ error: "forbidden" });
  next();
}
function noLawyers(req, res, next) {
  if (isLawyer(req.user)) return res.status(403).json({ error: "forbidden" });
  next();
}
function managersOnly(req, res, next) {
  if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
  next();
}

const PAGE_SIZE = 30;
const PERSON = { select: { id: true, username: true, employee: { select: { name: true } } } };
const today = () => firmNow().date;

function sendError(err, res, next) {
  if (err instanceof cl.ClientError || err instanceof history.HistoryError) return res.status(400).json({ error: err.message });
  if (err.status === 403 || err.status === 404) return res.status(err.status).json({ error: err.message });
  if (err.code === "P2025") return res.status(404).json({ error: "not_found" });
  if (err.code === "P2002") return res.status(409).json({ error: "already_exists" });
  return next(err);
}

// A case's input without the contract amount, for people who can't see money.
function caseInput(req, b) {
  if (!b || canSeeFinance(req.user)) return b || {};
  const { contractAmount, ...rest } = b;
  return rest;
}

function clientFields(b) {
  const data = {};
  if (b.name !== undefined) {
    const name = cl.text(b.name, 160);
    if (!name) throw badRequest("name is required");
    data.name = name;
  }
  for (const [key, max] of [
    ["city", 80],
    ["email", 160],
    ["notes", 2000],
    ["nextCallNote", 300],
  ]) {
    const v = cl.text(b[key], max);
    if (v !== undefined) data[key] = v;
  }
  const source = cl.oneOf(b.source, cl.SOURCES, "source");
  if (source !== undefined) data.source = source;
  // Kept out of the automatic archive until the end of that day
  // (services/clientArchive.js); null takes it off.
  if (b.keepUntil !== undefined) {
    if (b.keepUntil === null || b.keepUntil === "") data.keepUntil = null;
    else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.keepUntil))) throw badRequest("invalid keepUntil");
      data.keepUntil = new Date(firmDayRange(String(b.keepUntil)).to);
    }
  }
  // The next call is the earliest open follow-up now (clientWork.js); see
  // the PATCH below for what setting it directly does.
  delete data.nextCallNote;
  return data;
}

// An operator's own cases count toward their targets; managers can assign
// any. Staff can put themselves on a case, or take themselves off one of
// theirs — not take a colleague off (and their monthly count with it).
// `current`: the case's operator now (undefined for a new case).
async function operatorFor(req, requested, current) {
  if (requested === undefined) return undefined;
  const own = req.user.employee?.id ?? null;
  const mayChange = isManager(req.user) || current == null || current === own;
  if (requested === null || requested === "") {
    if (!mayChange) throw badRequest("can only assign yourself");
    return null;
  }
  const id = parseId(requested, "operatorId");
  if (!isManager(req.user) && (id !== own || !mayChange)) throw badRequest("can only assign yourself");
  const exists = await prisma.employee.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw badRequest("unknown operator");
  return id;
}

// A case's lawyer: an account (its name goes into `lawyer` too), or none.
// undefined: not given. Assigning a lawyer opens the client to them, so
// staff can only choose one for a case that has none yet (`current`: the
// case's lawyer now; undefined for a new case); changing it is for managers.
async function lawyerFor(requested, req, current) {
  if (requested === undefined) return undefined;
  if (req && !isManager(req.user) && current != null && Number(requested) !== current) throw badRequest("only a manager can change the lawyer");
  if (requested === null || requested === "") return { lawyerId: null };
  const lawyer = await lawyerById(parseId(requested, "lawyerId"));
  if (!lawyer) throw badRequest("unknown lawyer");
  return { lawyerId: lawyer.id, lawyer: lawyer.name };
}

async function loadClient(id) {
  const client = await prisma.client.findUnique({ where: { id }, select: { id: true, archivedAt: true } });
  if (!client) {
    const err = new Error("not_found");
    err.code = "P2025";
    throw err;
  }
  return client;
}

const LINKED = {
  phones: { select: { phone: true }, orderBy: { id: "asc" }, take: 1 },
  cases: { select: { status: true }, orderBy: { updatedAt: "desc" }, take: 1 },
};
function linkedSummary(c) {
  return { id: c.id, name: c.name, phone: c.phones[0]?.phone || null, status: c.cases[0]?.status || null, archived: Boolean(c.archivedAt) };
}

// Records who did what; `detail` keeps a copy of anything removed.
function audit(db, req, action, entity, entityId, detail) {
  return db.auditLog.create({ data: { userId: req.user.id, action, entity, entityId, detail } });
}

// Case numbers with the payment summary the portal shows — and, when the
// contract has a payment schedule, where each installment stands.
function withMoney(c) {
  const out = { ...c, ...cl.paymentSummary(c.contractAmount, c.payments || []) };
  if (Array.isArray(c.installments)) {
    const { installments, ...rest } = out;
    return { ...rest, schedule: scheduleOf(installments, c.payments || [], today()) };
  }
  return out;
}

// ------------------------------------------------------------------ list
const clients = express.Router();
clients.use(requireAuth, gate, lawyerGate);

// Sections, so ongoing work isn't buried under one-off consultations:
//   ?section=clients        clients with a contract (or a finished case) —
//                           for a coordinator, the cases they look after
//   ?section=consultations  everyone else — consultations, "call again",
//                           declined; for an operator, the ones they work on
//   ?section=results        an operator's clients who signed a contract (they
//                           see each as a result: name, number, dates)
//   ?section=unassigned     managers: contracts still without a coordinator
//                           or a lawyer
// (no section: everyone, e.g. when searching). A lawyer: by their own cases.
function sectionWhere(section, user) {
  if (section === "unassigned") return isManager(user) ? { cases: { some: { status: "contract", OR: [{ coordinatorId: null }, { lawyerId: null }] } } } : { id: -1 };
  if (isManager(user) || isLawyer(user)) {
    const own = ownCaseWhere(user);
    if (section === "clients") return { cases: { some: { ...own, status: { in: CONTRACT_STATUSES } } } };
    if (section === "consultations") return { cases: { none: { ...own, status: { in: CONTRACT_STATUSES } } } };
    if (section === "results") return { id: -1 };
    return null;
  }
  const me = user.employee?.id ?? -1;
  if (section === "clients") return { cases: { some: { coordinatorId: me } } };
  if (section === "consultations") {
    return {
      OR: [
        { cases: { some: { operatorId: me, status: { notIn: CONTRACT_STATUSES } } } },
        { createdById: user.id, cases: { none: { operatorId: { not: null } } } },
      ],
    };
  }
  if (section === "results") return { cases: { some: { operatorId: me, status: { in: CONTRACT_STATUSES } } } };
  return null;
}

// ?q= name / phone / case number (Latin or Cyrillic) · ?filter= callToday |
// debt | active | archived (managers) · ?status= · ?legalStage= ·
// ?operatorId= · ?lawyerId= · ?lawyer=  — archived clients only appear under
// "archived". A lawyer: only clients with a case of theirs, filtered by those.
async function listQuery(q, user) {
  const and = [q.filter === "archived" && isManager(user) ? { archivedAt: { not: null } } : { archivedAt: null }];
  // Staff and lawyers: only the clients they may see.
  if (!isManager(user)) and.push(clientScope(user));
  for (const word of cl.searchable(q.q || "").split(" ").filter(Boolean)) {
    and.push({ searchText: { contains: word } });
  }
  const caseWhere = {};
  if (q.status) caseWhere.status = cl.oneOf(q.status, cl.STATUSES, "status");
  if (q.legalStage) caseWhere.legalStage = cl.oneOf(q.legalStage, cl.LEGAL_STAGES, "legalStage");
  // "none": cases nobody is assigned to yet — to find and fill in.
  if (q.operatorId) caseWhere.operatorId = q.operatorId === "none" ? null : parseId(q.operatorId, "operatorId");
  if (q.lawyerId) caseWhere.lawyerId = q.lawyerId === "none" ? null : parseId(q.lawyerId, "lawyerId");
  if (q.coordinatorId && isManager(user)) caseWhere.coordinatorId = q.coordinatorId === "none" ? null : parseId(q.coordinatorId, "coordinatorId");
  if (q.lawyer) caseWhere.lawyer = String(q.lawyer);
  if (q.filter === "active") caseWhere.status = caseWhere.status || { in: cl.OPEN_STATUSES };
  if (!isManager(user) && Object.keys(caseWhere).length > 0) Object.assign(caseWhere, ownCaseWhere(user));
  if (Object.keys(caseWhere).length > 0) and.push({ cases: { some: caseWhere } });

  let orderBy = [{ updatedAt: "desc" }];
  if (q.filter === "callToday") {
    and.push({ nextCallAt: { not: null, lte: new Date(firmDayRange(today()).to) } });
    // Only clients they work on now — not a past result (the coordinator
    // calls those).
    if (!isManager(user)) and.push(workScope(user));
    orderBy = [{ nextCallAt: "asc" }];
  }
  if (q.filter === "debt") {
    // Moliya (a lawyer: their own cases), or a coordinator's own cases.
    if (canSeeFinance(user)) and.push({ id: { in: await clientIdsWithDebt(isLawyer(user) ? { lawyerId: user.id } : {}) } });
    else if (isCoordinator(user.employee)) and.push({ id: { in: await clientIdsWithDebt({ coordinatorId: user.employee.id }) } });
    else throw financeForbidden();
  }
  // Archived clients are shown whatever their section.
  if (q.filter !== "archived") {
    const section = sectionWhere(q.section, user);
    if (section) and.push(section);
  }
  if (q.filter === "stale") {
    // Consultations that went nowhere: still "consultation" or "call again"
    // after 30 days (or with no date — from the old spreadsheets), and no
    // contract. To close them in one go ("didn't continue").
    and.push({ cases: { some: { status: { in: ["consultation", "call_again"] }, OR: [{ startDate: null }, { startDate: { lt: shiftDate(today(), -30) } }] } } });
    and.push({ cases: { none: { status: { in: ["contract", "done"] } } } });
  }
  return { where: { AND: and }, orderBy };
}

// Which section tabs this person gets.
function sectionsFor(user) {
  if (isManager(user)) return ["clients", "consultations", "unassigned"];
  if (isLawyer(user)) return ["clients", "consultations"];
  if (isCoordinator(user.employee)) return ["clients", "consultations"];
  return ["consultations", "results"];
}

clients.get("/", async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const { where, orderBy } = await listQuery(req.query, req.user);
    // How many each section has with the same filters — for the tabs.
    const sectionCount = async (section) => prisma.client.count({ where: (await listQuery({ ...req.query, section }, req.user)).where });
    const sections = req.query.section ? Object.fromEntries(await Promise.all(sectionsFor(req.user).map(async (s) => [s, await sectionCount(s)]))) : null;
    const [rows, total] = await Promise.all([
      prisma.client.findMany({
        where,
        orderBy,
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          phones: { select: { phone: true }, orderBy: { id: "asc" } },
          cases: {
            // A lawyer: their own cases only.
            ...(isLawyer(req.user) ? { where: { lawyerId: req.user.id } } : {}),
            orderBy: { updatedAt: "desc" },
            select: {
              id: true,
              status: true,
              legalStage: true,
              lawyer: true,
              lawyerId: true,
              operatorId: true,
              coordinatorId: true,
              consultationDate: true,
              contractDate: true,
              contractAmount: true,
              operator: { select: { id: true, name: true } },
              coordinator: { select: { id: true, name: true } },
              payments: { select: { amount: true, kind: true } },
            },
          },
        },
      }),
      prisma.client.count({ where }),
    ]);

    res.json({
      clients: rows.map(({ phones, cases, searchText, extra, ...c }) => {
        const phone = phones[0]?.phone || null;
        const { level, roles } = clientLevel(req.user, { ...c, cases });
        // Signed with an operator's help, now the coordinator's: the operator
        // sees who and when — not the case.
        if (level === "result") {
          return {
            id: c.id,
            name: c.name,
            phone,
            archivedAt: c.archivedAt,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            result: true,
            signed: cases.filter((k) => roles.get(k.id) === "result").map((k) => ({ consultationDate: k.consultationDate, contractDate: k.contractDate, coordinator: k.coordinator?.name ?? null })),
          };
        }
        const visible = cases.filter((k) => roles.get(k.id) && roles.get(k.id) !== "result");
        const withMoneyCases = visible.filter((k) => canSeeCaseMoney(req.user, k));
        const latest = visible[0] || null;
        return {
          ...c,
          phone,
          latestCase: latest
            ? (({ payments, contractAmount, operatorId, coordinatorId, ...k }) => (canSeeCaseMoney(req.user, latest) ? { ...k, contractAmount } : k))(latest)
            : null,
          caseCount: visible.length,
          ...(withMoneyCases.length ? { debt: withMoneyCases.reduce((sum, k) => sum + cl.paymentSummary(k.contractAmount, k.payments).remaining, 0) } : {}),
        };
      }),
      pagination: { page, pageSize: PAGE_SIZE, total, totalPages: Math.ceil(total / PAGE_SIZE) },
      ...(sections ? { sections } : {}),
    });
  } catch (err) {
    sendError(err, res, next);
  }
});

async function clientIdsWithDebt(caseWhere = {}) {
  const cases = await prisma.clientCase.findMany({
    where: { contractAmount: { gt: 0 }, ...caseWhere },
    select: { clientId: true, contractAmount: true, payments: { select: { amount: true, kind: true } } },
  });
  return [...new Set(cases.filter((k) => cl.paymentSummary(k.contractAmount, k.payments).remaining > 0).map((k) => k.clientId))];
}

// The current list (same filters) as an Excel file — one row per case; the
// column titles are ones the importer recognises, so it can be imported back.
const EXPORT_STATUS = { consultation: "Konsultatsiya", call_again: "Qayta qoʻngʻiroq", contract: "Shartnoma tuzildi", done: "Ish tugallandi", declined: "Davom etmadi" };
const EXPORT_STAGE = {
  inquiry: "Surishtiruv",
  investigation: "Tergov harakatlari",
  sent_to_court: "Sudga yuborildi",
  first_instance: "Birinchi instansiya",
  appeal: "Apellyatsiya",
  cassation: "Kassatsiya",
  review: "Taftish",
  supreme_review: "Oliy sud taftishi",
};
const EXPORT_SOURCE = { call: "Qoʻngʻiroq", telegram: "Telegram", instagram: "Instagram", referral: "Tavsiya", walk_in: "Oʻzi keldi", other: "Boshqa" };

clients.get("/export", managersOnly, async (req, res, next) => {
  try {
    const { where } = await listQuery(req.query, req.user);
    const rows = await prisma.client.findMany({
      where,
      orderBy: { name: "asc" },
      include: {
        phones: { orderBy: { id: "asc" } },
        cases: { orderBy: { createdAt: "asc" }, include: { operator: { select: { name: true } }, payments: { select: { amount: true, kind: true } } } },
      },
    });
    // "2026-09-28 14:30" in the firm's time, whatever the server's clock.
    const firmClock = new Intl.DateTimeFormat("sv-SE", { timeZone: env.firmTimezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const when = (d) => (d ? firmClock.format(d) : "");
    // The money columns only for people who see money.
    const withMoney = canSeeFinance(req.user);
    const moneyHeader = withMoney ? ["Shartnoma summasi", "Toʻlangan", "Qoldi"] : [];
    const header = ["ID", "Mijoz", "Telefonlar", "Shahar", "Qayerdan", "Ish bosqichi", "Masala", "Advokat", "Operator", "Ish raqami", "Boshlangan sana", ...moneyHeader, "Keyingi qoʻngʻiroq", "Izoh"];
    const table = [header];
    for (const c of rows) {
      const base = [c.id, c.name, c.phones.map((p) => p.phone).join(", "), c.city || "", EXPORT_SOURCE[c.source] || ""];
      const tail = [when(c.nextCallAt), c.notes || ""];
      if (c.cases.length === 0) table.push([...base, "", "", "", "", "", "", ...moneyHeader.map(() => ""), ...tail]);
      for (const k of c.cases) {
        const money = cl.paymentSummary(k.contractAmount, k.payments);
        const stage = [EXPORT_STATUS[k.status], EXPORT_STAGE[k.legalStage]].filter(Boolean).join(" · ");
        const moneyCells = withMoney ? [k.contractAmount || "", money.paid || "", money.remaining || ""] : [];
        table.push([...base, stage, k.matter || "", k.lawyer || "", k.operator?.name || "", k.number || "", k.startDate || "", ...moneyCells, ...tail]);
      }
    }
    const widths = [6, 28, 22, 14, 12, 30, 28, 24, 20, 14, 14, ...(withMoney ? [16, 14, 14] : []), 18, 30];
    const file = buildXlsx({ sheetName: "Mijozlar", rows: table, widths });
    res.set("Content-Disposition", `attachment; filename="mijozlar-${today()}.xlsx"`);
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(file);
  } catch (err) {
    sendError(err, res, next);
  }
});

// Clients with this phone number — for calls and bookings.
clients.get("/lookup", async (req, res, next) => {
  try {
    const key = phoneKey(String(req.query.phone || ""));
    if (!key) return res.json([]);
    // Someone else's client: only that the number is taken, and by whom.
    const found = (await clientIndexFor(req.user, [key])).get(key);
    res.json(found ? [found] : []);
  } catch (err) {
    next(err);
  }
});

// Who a case can be assigned to: the lawyer accounts ({ id, name }), and
// other names already written on cases (lawyers without an account).
clients.get("/lawyers", async (req, res, next) => {
  try {
    const [accounts, rows] = await Promise.all([
      lawyerAccounts(),
      prisma.clientCase.findMany({ where: { lawyer: { not: null }, lawyerId: null }, distinct: ["lawyer"], select: { lawyer: true }, orderBy: { lawyer: "asc" } }),
    ]);
    const taken = new Set(accounts.map((a) => a.name));
    res.json({ accounts, names: rows.map((r) => r.lawyer).filter((n) => !taken.has(n)) });
  } catch (err) {
    next(err);
  }
});

// Who a contract can be handed to: staff whose job is coordinator first,
// then everyone else active (managers assign).
clients.get("/coordinators", managersOnly, async (req, res, next) => {
  try {
    const rows = await prisma.employee.findMany({ where: { active: true }, select: { id: true, name: true, job: true }, orderBy: { name: "asc" } });
    res.json({ coordinators: rows.filter((e) => e.job === "coordinator"), others: rows.filter((e) => e.job !== "coordinator") });
  } catch (err) {
    next(err);
  }
});

// This month's consultations and contracts per operator, against their
// position's targets. Staff see only their own row.
clients.get("/targets", async (req, res, next) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : today().slice(0, 7);
    const from = `${month}-01`;
    const to = `${month}-31`;
    const mineOnly = !isManager(req.user);
    const employees = await prisma.employee.findMany({
      where: {
        active: true,
        ...(mineOnly ? { id: req.user.employee?.id ?? -1 } : {}),
        OR: [
          { position: { OR: [{ targetConsultations: { not: null } }, { targetContracts: { not: null } }] } },
          { cases: { some: { OR: [{ consultationDate: { gte: from, lte: to } }, { contractDate: { gte: from, lte: to } }] } } },
        ],
      },
      select: { id: true, name: true, position: { select: { targetConsultations: true, targetContracts: true } } },
      orderBy: { name: "asc" },
    });
    const count = (field, operatorId) =>
      prisma.clientCase.count({ where: { operatorId, [field]: { gte: from, lte: to } } });
    const rows = await Promise.all(
      employees.map(async (e) => ({
        employee: { id: e.id, name: e.name },
        consultations: await count("consultationDate", e.id),
        contracts: await count("contractDate", e.id),
        targetConsultations: e.position?.targetConsultations ?? null,
        targetContracts: e.position?.targetContracts ?? null,
      }))
    );
    res.json({ month, rows });
  } catch (err) {
    next(err);
  }
});

clients.post("/", async (req, res, next) => {
  try {
    const b = req.body || {};
    const data = clientFields(b);
    if (!data.name) throw badRequest("name is required");
    const phones = cl.normalizePhones(b.phones || []);
    if (b.force !== true) {
      const clash = await clientsByPhoneKeys(prisma, phones.map((p) => p.phoneKey));
      if (clash.length > 0) return res.status(409).json({ error: "phone_exists", client: (await clientIndexFor(req.user, [clash[0].phoneKey])).get(clash[0].phoneKey) });
    }
    const firstCase = b.case ? { ...cl.normalizeCase(caseInput(req, b.case), {}, today()), ...((await lawyerFor(b.case.lawyerId, req)) || {}) } : null;
    const operatorId = b.case ? ((await operatorFor(req, b.case.operatorId)) ?? req.user.employee?.id ?? null) : null;
    const client = await prisma.$transaction(async (tx) => {
      const created = await tx.client.create({
        data: {
          ...data,
          createdById: req.user.id,
          phones: { create: phones },
          ...(firstCase ? { cases: { create: [{ ...firstCase, operatorId }] } } : {}),
        },
      });
      await refreshSearch(tx, created.id);
      return created;
    });
    res.status(201).json(client);
  } catch (err) {
    sendError(err, res, next);
  }
});

// One client, with everything the client page shows, shaped by who's
// looking (src/lib/clientAccess.js):
//   - phones, details, connections, the next call
//   - cases with their people (operator, coordinator, lawyer), stage history
//     with dates, key dates (hearings, deadlines), money where allowed
//   - the timeline: notes, status and stage changes, assignments, edits —
//     plus calls and appointments found through their phone numbers
// `view: "result"`: an operator whose client signed — name, number, the
// dates and their own calls, nothing of the case.
const CASE_INCLUDE = {
  operator: { select: { id: true, name: true } },
  coordinator: { select: { id: true, name: true } },
  payments: { orderBy: [{ date: "desc" }, { id: "desc" }], include: { recordedBy: PERSON } },
  installments: true,
  stages: { where: { deletedAt: null }, orderBy: [{ date: "asc" }, { id: "asc" }], include: { createdBy: PERSON } },
  dates: { where: { deletedAt: null }, orderBy: [{ date: "asc" }, { time: "asc" }, { id: "asc" }], include: { createdBy: PERSON } },
};

// What this person may do on a case, for the portal's buttons (the server
// checks each action again).
function casePermissions(user, role, k) {
  const manager = role === "manager";
  const people = manager || role === "lawyer" || role === "coordinator";
  return {
    role,
    canEdit: manager || role === "lawyer" || role === "coordinator" || role === "operator",
    canStatus: manager || role === "lawyer" || role === "operator",
    canHistory: people,
    canDates: people,
    canAssign: manager,
    canPay: canSeeFinance(user) || role === "coordinator",
    canSchedule: canSeeFinance(user) && (manager || role === "lawyer"),
    money: canSeeCaseMoney(user, k),
  };
}

function callSelect() {
  return {
    id: true,
    callType: true,
    missed: true,
    followUp: true,
    callTimestampMs: true,
    durationSeconds: true,
    recordingPath: true,
    employee: { select: { id: true, name: true, job: true } },
  };
}

clients.get("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const { level, roles } = await requireClientAccess(req.user, id);
    const me = req.user.employee?.id ?? -1;
    const client = await prisma.client.findUnique({
      where: { id },
      include: {
        phones: { orderBy: { id: "asc" } },
        createdBy: PERSON,
        cases: { orderBy: { createdAt: "desc" }, include: CASE_INCLUDE },
        payments: { orderBy: [{ date: "desc" }, { id: "desc" }], include: { recordedBy: PERSON } },
        events: { where: { deletedAt: null }, orderBy: { createdAt: "desc" }, take: 500, include: { author: PERSON } },
        linksFrom: { include: { to: { include: LINKED } } },
        linksTo: { include: { from: { include: LINKED } } },
        contacts: { where: { deletedAt: null }, orderBy: [{ decides: "desc" }, { id: "asc" }] },
        followUps: { orderBy: { dueAt: "asc" }, include: FOLLOW_UP_INCLUDE },
        files: { where: { deletedAt: null }, orderBy: { createdAt: "desc" }, include: { uploadedBy: PERSON } },
      },
    });
    if (!client) return res.status(404).json({ error: "not_found" });
    // Their numbers, and the numbers of the people connected to them.
    const keys = [...client.phones.map((p) => p.phoneKey), ...client.contacts.map((c) => c.phoneKey)].filter(Boolean);

    // ---- an operator's past result: who and when, nothing of the case.
    if (level === "result") {
      const [calls, appointments] = await Promise.all([
        keys.length ? prisma.callLog.findMany({ where: { phoneKey: { in: keys }, employeeId: me }, orderBy: { callTimestampMs: "desc" }, take: 100, select: callSelect() }) : [],
        prisma.appointment.findMany({
          where: { bookedById: req.user.id, OR: [{ clientId: id }, ...(keys.length ? [{ phoneKey: { in: keys } }] : [])] },
          orderBy: [{ date: "desc" }, { start: "desc" }],
          take: 50,
          select: { id: true, date: true, start: true, end: true, status: true, format: true, calendarId: true, calendar: { select: { id: true, name: true } } },
        }),
      ]);
      return res.json({
        id: client.id,
        view: "result",
        name: client.name,
        phones: client.phones.map((p) => ({ id: p.id, phone: p.phone })),
        createdAt: client.createdAt,
        createdBy: client.createdBy,
        archivedAt: client.archivedAt,
        results: client.cases
          .filter((k) => roles.get(k.id) === "result")
          .map((k) => ({ id: k.id, status: k.status, startDate: k.startDate, consultationDate: k.consultationDate, contractDate: k.contractDate, coordinator: k.coordinator?.name ?? null })),
        calls: calls.map(({ recordingPath, ...c }) => ({ ...c, hasRecording: Boolean(recordingPath) })),
        appointments,
        canManage: false,
      });
    }

    const manager = level === "manager";
    const lawyer = isLawyer(req.user);
    // The cases they work on, and (an operator with a new consultation for a
    // client who signed before) their past results, as results.
    const visible = client.cases.filter((k) => roles.has(k.id) && roles.get(k.id) !== "result");
    const results = client.cases.filter((k) => roles.get(k.id) === "result");
    const visibleIds = new Set(visible.map((k) => k.id));
    const moneyIds = new Set(visible.filter((k) => canSeeCaseMoney(req.user, k)).map((k) => k.id));

    // Calls with their numbers: managers and coordinators all of them (the
    // whole history matters after the contract); staff their own; a lawyer
    // none.
    const callWhere = manager || level === "coordinator" ? {} : { employeeId: me };
    const [calls, appointments] = await Promise.all([
      keys.length && !lawyer
        ? prisma.callLog.findMany({ where: { phoneKey: { in: keys }, ...callWhere }, orderBy: { callTimestampMs: "desc" }, take: 200, select: callSelect() })
        : [],
      prisma.appointment.findMany({
        where: {
          OR: [{ clientId: id }, ...(keys.length ? [{ phoneKey: { in: keys } }] : [])],
          // A lawyer: appointments in their own calendar.
          ...(lawyer ? { calendar: { ownerId: req.user.id } } : {}),
        },
        orderBy: [{ date: "desc" }, { start: "desc" }],
        take: 50,
        include: { calendar: { select: { id: true, name: true } }, bookedBy: PERSON },
      }),
    ]);

    const { linksFrom, linksTo, searchText, extra, cases, payments, events, followUps, files, contacts, ...rest } = client;
    // About the client, or about a case they see.
    const caseVisible = (caseId) => manager || caseId == null || visibleIds.has(caseId);
    // Open ones, and the last 30 closed.
    const shownFollowUps = followUps.filter((f) => caseVisible(f.caseId) && f.client);
    const openFollowUps = shownFollowUps.filter((f) => f.status === "open");
    const closedFollowUps = shownFollowUps.filter((f) => f.status !== "open").sort((a, b) => (b.doneAt?.getTime() ?? 0) - (a.doneAt?.getTime() ?? 0)).slice(0, 30);
    // Connected clients the viewer may not open show only as "a client".
    const visibleLinked = await accessibleClientIds(req.user, [...linksFrom.map((l) => l.to.id), ...linksTo.map((l) => l.from.id)]);
    const shownLink = (other) => (visibleLinked.has(other.id) ? linkedSummary(other) : { id: null, name: null, phone: null, status: null, archived: false, restricted: true });

    const caseOut = (k) => {
      const base = moneyIds.has(k.id) ? withMoney(k) : caseWithoutMoney(k);
      return { ...base, permissions: casePermissions(req.user, roles.get(k.id), k) };
    };
    // Payments: consultation fees for everyone who sees the client; the rest
    // only on cases whose money they see (Moliya: all, unattached ones too).
    const shownPayments = payments.filter((p) => {
      if (p.caseId != null && !visibleIds.has(p.caseId) && !manager) return false;
      if (isConsultation(p)) return true;
      return p.caseId != null ? moneyIds.has(p.caseId) : canSeeFinance(req.user);
    });
    // The timeline: about the client as a whole, or about a case they see. A
    // lawyer: notes about the client, and everything about their cases.
    const shownEvents = events.filter((e) => {
      if (manager) return true;
      if (e.caseId == null) return lawyer ? e.kind === "note" : true;
      return visibleIds.has(e.caseId);
    });

    res.json({
      ...rest,
      view: "full",
      level,
      cases: visible.map(caseOut),
      results: results.map((k) => ({ id: k.id, status: k.status, consultationDate: k.consultationDate, contractDate: k.contractDate, coordinator: k.coordinator?.name ?? null })),
      payments: shownPayments,
      finance: canSeeFinance(req.user),
      events: shownEvents,
      links: lawyer
        ? []
        : [
            ...linksFrom.map((l) => ({ id: l.id, kind: l.kind, label: l.label, direction: "from", other: shownLink(l.to) })),
            ...linksTo.map((l) => ({ id: l.id, kind: l.kind, label: l.label, direction: "to", other: shownLink(l.from) })),
          ],
      calls: calls.map(({ recordingPath, ...c }) => ({ ...c, hasRecording: Boolean(recordingPath) })),
      appointments,
      contacts: contacts.map(({ phoneKey: _k, ...c }) => c),
      followUps: [...openFollowUps, ...closedFollowUps].map(({ client: _c, ...f }) => f),
      files: files.filter((f) => caseVisible(f.caseId)).map(({ path: _p, ...f }) => f),
      me: req.user.id,
      canManage: manager,
      canEdit: level !== "lawyer",
      asLawyer: lawyer,
    });
  } catch (err) {
    sendError(err, res, next);
  }
});

clients.patch("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    await loadClient(id);
    await requireClientAccess(req.user, id, { write: true });
    const b = req.body || {};
    const data = clientFields(b);
    const phones = cl.normalizePhones(b.phones);
    if (phones && b.force !== true) {
      const clash = await clientsByPhoneKeys(prisma, phones.map((p) => p.phoneKey), { exceptId: id });
      if (clash.length > 0) return res.status(409).json({ error: "phone_exists", client: (await clientIndexFor(req.user, [clash[0].phoneKey])).get(clash[0].phoneKey) });
    }
    const client = await prisma.$transaction(async (tx) => {
      const updated = await tx.client.update({ where: { id }, data });
      // On the timeline: kept out of the archive until when, or not any more.
      if (b.keepUntil !== undefined) {
        const until = data.keepUntil ? String(b.keepUntil) : null;
        await tx.clientEvent.create({ data: { clientId: id, kind: "keep", text: until || "", authorId: req.user.id, data: { until } } });
      }
      // "Next call" set directly (older portals): a call follow-up for
      // yourself; cleared: your open calls on this client are done.
      if (b.nextCallAt !== undefined) {
        if (b.nextCallAt === null || b.nextCallAt === "") {
          await tx.clientFollowUp.updateMany({ where: { clientId: id, status: "open", kind: "call", assigneeId: req.user.id }, data: { status: "done", doneAt: new Date(), doneById: req.user.id } });
        } else {
          const when = new Date(b.nextCallAt);
          if (Number.isNaN(when.getTime())) throw badRequest("invalid nextCallAt");
          await tx.clientFollowUp.create({ data: { clientId: id, kind: "call", dueAt: when, note: cl.text(b.nextCallNote, 300) ?? null, assigneeId: req.user.id, createdById: req.user.id } });
        }
        await syncNextCall(tx, id);
      }
      if (phones) {
        await tx.clientPhone.deleteMany({ where: { clientId: id } });
        if (phones.length) await tx.clientPhone.createMany({ data: phones.map((p) => ({ ...p, clientId: id })) });
      }
      await refreshSearch(tx, id);
      return updated;
    });
    res.json(client);
  } catch (err) {
    sendError(err, res, next);
  }
});

// "Delete" archives: the client disappears from lists but everything is kept
// and can be restored. There is no permanent delete in the portal.
clients.delete("/:id", managersOnly, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const client = await loadClient(id);
    if (client.archivedAt) return res.status(204).end();
    await prisma.$transaction([
      prisma.client.update({ where: { id }, data: { archivedAt: new Date() } }),
      prisma.clientEvent.create({ data: { clientId: id, kind: "archive", text: "", authorId: req.user.id } }),
      prisma.auditLog.create({ data: { userId: req.user.id, action: "client.archive", entity: "client", entityId: id } }),
    ]);
    res.status(204).end();
  } catch (err) {
    sendError(err, res, next);
  }
});

clients.post("/:id/restore", managersOnly, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const client = await loadClient(id);
    if (!client.archivedAt) return res.status(204).end();
    await prisma.$transaction([
      prisma.client.update({ where: { id }, data: { archivedAt: null } }),
      prisma.clientEvent.create({ data: { clientId: id, kind: "restore", text: "", authorId: req.user.id } }),
      prisma.auditLog.create({ data: { userId: req.user.id, action: "client.restore", entity: "client", entityId: id } }),
    ]);
    res.status(204).end();
  } catch (err) {
    sendError(err, res, next);
  }
});

// Two records of the same person: everything of `otherId` — phones, cases
// and payments, notes, appointments, connections — moves to this client,
// empty fields are filled in, and the emptied duplicate is removed (a copy of
// its details goes into the audit log).
clients.post("/:id/merge", managersOnly, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const otherId = parseId(req.body?.otherId, "otherId");
    if (id === otherId) throw badRequest("can't merge a client into themselves");
    const [keep, gone] = await Promise.all(
      [id, otherId].map((cid) => prisma.client.findUnique({ where: { id: cid }, include: { phones: true } }))
    );
    if (!keep || !gone) return res.status(404).json({ error: "not_found" });

    await prisma.$transaction(async (tx) => {
      const have = new Set(keep.phones.map((p) => p.phoneKey).filter(Boolean));
      let count = keep.phones.length;
      const spare = [];
      for (const p of gone.phones) {
        if (p.phoneKey && have.has(p.phoneKey)) {
          await tx.clientPhone.delete({ where: { id: p.id } });
        } else if (count >= cl.MAX_PHONES) {
          spare.push(p.phone);
          await tx.clientPhone.delete({ where: { id: p.id } });
        } else {
          await tx.clientPhone.update({ where: { id: p.id }, data: { clientId: id } });
          if (p.phoneKey) have.add(p.phoneKey);
          count += 1;
        }
      }
      for (const model of ["clientCase", "payment", "clientEvent", "appointment", "clientContact", "clientFollowUp", "clientFile"]) {
        await tx[model].updateMany({ where: { clientId: otherId }, data: { clientId: id } });
      }
      const links = await tx.clientLink.findMany({ where: { OR: [{ fromId: otherId }, { toId: otherId }] } });
      for (const l of links) {
        await tx.clientLink.delete({ where: { id: l.id } });
        const fromId = l.fromId === otherId ? id : l.fromId;
        const toId = l.toId === otherId ? id : l.toId;
        if (fromId === toId) continue;
        await tx.clientLink.upsert({
          where: { fromId_toId_kind: { fromId, toId, kind: l.kind } },
          update: {},
          create: { fromId, toId, kind: l.kind, label: l.label },
        });
      }
      const fill = {};
      for (const key of ["city", "email", "source"]) if (!keep[key] && gone[key]) fill[key] = gone[key];
      const extraNotes = [gone.notes, spare.join(", ")].filter(Boolean).join("\n");
      if (extraNotes) fill.notes = keep.notes ? `${keep.notes}\n${extraNotes}` : extraNotes;
      if (gone.nextCallAt && (!keep.nextCallAt || gone.nextCallAt < keep.nextCallAt)) {
        fill.nextCallAt = gone.nextCallAt;
        fill.nextCallNote = gone.nextCallNote;
      }
      if (keep.archivedAt && !gone.archivedAt) fill.archivedAt = null;
      delete fill.nextCallAt;
      delete fill.nextCallNote;
      if (Object.keys(fill).length) await tx.client.update({ where: { id }, data: fill });
      await syncNextCall(tx, id);
      await tx.clientEvent.create({ data: { clientId: id, kind: "merge", text: gone.name, authorId: req.user.id } });
      await audit(tx, req, "client.merge", "client", id, {
        merged: { id: gone.id, name: gone.name, phones: gone.phones.map((p) => p.phone), city: gone.city, email: gone.email, notes: gone.notes },
      });
      await tx.client.delete({ where: { id: otherId } });
      await refreshSearch(tx, id);
    });
    res.json({ ok: true });
  } catch (err) {
    sendError(err, res, next);
  }
});

// ----------------------------------------------------------------- cases
clients.post("/:id/cases", async (req, res, next) => {
  try {
    const clientId = parseId(req.params.id);
    await loadClient(clientId);
    await requireClientAccess(req.user, clientId);
    const b = caseInput(req, req.body);
    const data = { ...cl.normalizeCase(b, {}, today()), ...((await lawyerFor(b.lawyerId, req)) || {}) };
    const operatorId = (await operatorFor(req, b.operatorId)) ?? req.user.employee?.id ?? null;
    const created = await prisma.$transaction(async (tx) => {
      const c = await tx.clientCase.create({ data: { ...data, clientId, operatorId } });
      await tx.clientEvent.create({ data: { clientId, caseId: c.id, kind: "case", text: c.matter || "", authorId: req.user.id } });
      await refreshSearch(tx, clientId);
      await tx.client.update({ where: { id: clientId }, data: { updatedAt: new Date() } });
      return c;
    });
    res.status(201).json(canSeeFinance(req.user) ? created : caseWithoutMoney(created));
  } catch (err) {
    sendError(err, res, next);
  }
});

const cases = express.Router();
cases.use(requireAuth, gate);

// What each role may change on a case (managers: everything). Money (the
// contract amount) only with Moliya, whoever it is.
//   lawyer       where it stands: status, number, matter, court, dates of it
//   coordinator  the case's number and court (history rows and key dates:
//                routes/caseWork.js)
//   operator     the consultation: what it's about, its status up to the
//                contract, its dates, themselves as operator, its lawyer
const CASE_FIELDS = {
  lawyer: ["status", "legalStage", "number", "matter", "court", "closedDate", "lostReason", "lostNote"],
  coordinator: ["number", "court", "legalStage"],
  operator: ["matter", "status", "startDate", "consultationDate", "operatorId", "lawyerId", "lawyer", "number", "lostReason", "lostNote"],
};
// An operator moves a consultation along — up to the contract (or "didn't
// continue"); finishing a contract is the lawyer's and the managers'.
const OPERATOR_STATUSES = ["consultation", "call_again", "contract", "declined"];
// Changes shown on the timeline field by field (money is kept out of it).
const TRACKED = ["matter", "number", "court", "startDate", "consultationDate", "contractDate", "closedDate"];

async function employeeName(tx, id) {
  if (id == null) return null;
  return (await tx.employee.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
}

// A coordinator for a case (managers): any active staff member — usually
// someone whose job is coordinator. undefined: not given; null: none.
async function coordinatorFor(requested, req) {
  if (requested === undefined) return undefined;
  if (!isManager(req.user)) throw Object.assign(new Error("forbidden"), { status: 403 });
  if (requested === null || requested === "") return null;
  const id = parseId(requested, "coordinatorId");
  const e = await prisma.employee.findUnique({ where: { id }, select: { id: true, active: true } });
  if (!e || !e.active) throw badRequest("unknown coordinator");
  return id;
}

// Status, stage, assignment and detail changes are written to the client's
// timeline; a contract signed and new people on a case are announced
// (Telegram, src/services/telegram/listeners.js).
cases.patch("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const current = await prisma.clientCase.findUnique({ where: { id }, include: { client: { select: { createdById: true, cases: { select: { operatorId: true } } } } } });
    if (!current) return res.status(404).json({ error: "not_found" });
    const role = caseRole(req.user, current, current.client);
    if (!role) return res.status(404).json({ error: "not_found" });
    if (role === "result") return res.status(403).json({ error: "result_only" });
    let b = caseInput(req, req.body);
    if (role !== "manager") {
      const allowed = CASE_FIELDS[role] || [];
      if (Object.keys(b).some((k) => !allowed.includes(k) && !(k === "contractAmount" && canSeeFinance(req.user)))) return res.status(403).json({ error: "forbidden" });
      if (role === "operator" && b.status !== undefined && !OPERATOR_STATUSES.includes(b.status)) return res.status(403).json({ error: "forbidden" });
    }
    const { legalStage, ...rest } = b;
    const data = cl.normalizeCase(rest, current, today());
    // A consultation that didn't continue: say why (it's what shows where
    // clients are lost).
    if (data.status === "declined" && current.status !== "declined" && !data.lostReason && !current.lostReason) throw badRequest("lost reason required");
    const operatorId = await operatorFor(req, b.operatorId, current.operatorId);
    if (operatorId !== undefined) data.operatorId = operatorId;
    const lawyer = await lawyerFor(b.lawyerId, req, current.lawyerId);
    if (lawyer) Object.assign(data, lawyer);
    const coordinatorId = await coordinatorFor(b.coordinatorId, req);
    if (coordinatorId !== undefined) data.coordinatorId = coordinatorId;
    // A stage picked straight from a list (older portals): a history row
    // dated today, so the history stays whole.
    const stage = legalStage === undefined ? undefined : cl.oneOf(legalStage, cl.LEGAL_STAGES, "legalStage");

    const updated = await prisma.$transaction(async (tx) => {
      let c = await tx.clientCase.update({ where: { id }, data });
      const log = (kind, text, extra) => tx.clientEvent.create({ data: { clientId: c.clientId, caseId: id, kind, text: text ?? "", data: extra ?? undefined, authorId: req.user.id } });
      if (data.status && data.status !== current.status) await log("status", `${current.status || ""}>${data.status}`);
      if (stage !== undefined && stage !== current.legalStage) {
        if (stage) {
          await tx.caseStage.create({ data: { caseId: id, stage, date: today(), createdById: req.user.id } });
          await log("stage_row", "", { action: "add", stage, date: today() });
        } else {
          // "No stage": the history rows stay; the case just has none now.
          await tx.caseStage.updateMany({ where: { caseId: id, deletedAt: null }, data: { deletedAt: new Date() } });
          await log("stage_row", "", { action: "clear" });
        }
        c = await history.syncCaseStage(tx, id);
      }
      for (const [field, key] of [
        ["operatorId", "operator"],
        ["coordinatorId", "coordinator"],
      ]) {
        if (data[field] !== undefined && data[field] !== current[field]) {
          await log("assign", "", { role: key, from: await employeeName(tx, current[field]), to: await employeeName(tx, data[field]) });
        }
      }
      if (data.lawyerId !== undefined && data.lawyerId !== current.lawyerId) await log("assign", "", { role: "lawyer", from: current.lawyer || null, to: data.lawyer || null });
      if (data.status === "declined" && current.status !== "declined") await log("lost", "", { reason: data.lostReason ?? current.lostReason ?? null, note: data.lostNote ?? null });
      const changes = TRACKED.filter((f) => data[f] !== undefined && (data[f] ?? null) !== (current[f] ?? null)).map((f) => ({ field: f, from: current[f] ?? null, to: data[f] ?? null }));
      if (changes.length) await log("case_edit", "", { changes });
      if (data.contractAmount !== undefined && data.contractAmount !== current.contractAmount) {
        await audit(tx, req, "case.amount", "case", id, { clientId: c.clientId, from: current.contractAmount, to: data.contractAmount });
      }
      if (data.number !== undefined) await refreshSearch(tx, c.clientId);
      await tx.client.update({ where: { id: c.clientId }, data: { updatedAt: new Date() } });
      return c;
    });
    if (data.status === "contract" && current.status !== "contract" && !CONTRACT_STATUSES.includes(current.status)) bus.emit("case.contract", { caseId: id, byUserId: req.user.id });
    if (data.coordinatorId && data.coordinatorId !== current.coordinatorId) bus.emit("case.assigned", { caseId: id, role: "coordinator", byUserId: req.user.id });
    if (data.lawyerId && data.lawyerId !== current.lawyerId) bus.emit("case.assigned", { caseId: id, role: "lawyer", byUserId: req.user.id });
    res.json(canSeeCaseMoney(req.user, updated) ? updated : caseWithoutMoney(updated));
  } catch (err) {
    sendError(err, res, next);
  }
});

// The contract's payment schedule, replaced as a whole: { items: [{ dueDate,
// amount, note? }] } ([] removes it). Contract money — Moliya only.
cases.put("/:id/installments", async (req, res, next) => {
  try {
    if (!canSeeFinance(req.user)) throw financeForbidden();
    const id = parseId(req.params.id);
    const current = await prisma.clientCase.findUnique({ where: { id }, select: { id: true, clientId: true, lawyerId: true } });
    if (!current) return res.status(404).json({ error: "not_found" });
    if (isLawyer(req.user) ? current.lawyerId !== req.user.id : false) return res.status(404).json({ error: "not_found" });
    if (!isLawyer(req.user)) await requireClientAccess(req.user, current.clientId);
    const items = normalizeSchedule(req.body?.items);
    await prisma.$transaction([
      prisma.caseInstallment.deleteMany({ where: { caseId: id } }),
      ...(items.length ? [prisma.caseInstallment.createMany({ data: items.map((i) => ({ ...i, caseId: id })) })] : []),
      prisma.clientEvent.create({ data: { clientId: current.clientId, caseId: id, kind: "note", text: items.length ? `Toʻlov jadvali: ${items.length} ta toʻlov` : "Toʻlov jadvali olib tashlandi", authorId: req.user.id } }),
    ]);
    const k = await prisma.clientCase.findUnique({ where: { id }, include: { operator: { select: { id: true, name: true } }, payments: { orderBy: { date: "desc" } }, installments: true } });
    res.json(withMoney(k));
  } catch (err) {
    sendError(err, res, next);
  }
});

cases.delete("/:id", managersOnly, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const c = await prisma.clientCase.findUnique({ where: { id }, include: { payments: true, installments: true, stages: true, dates: true } });
    if (!c) return res.status(404).json({ error: "not_found" });
    await prisma.$transaction(async (tx) => {
      await audit(tx, req, "case.delete", "case", id, { case: c });
      await tx.clientCase.delete({ where: { id } });
      await refreshSearch(tx, c.clientId);
    });
    res.status(204).end();
  } catch (err) {
    sendError(err, res, next);
  }
});

// -------------------------------------------------------------- payments
// Recording a payment: anyone who works with the client can record a
// consultation fee; any other payment people who see money — Moliya, or the
// coordinator of that case (it goes through Kassa like every cash payment).
clients.post("/:id/payments", async (req, res, next) => {
  try {
    const clientId = parseId(req.params.id);
    await loadClient(clientId);
    const { roles } = await requireClientAccess(req.user, clientId, { write: true });
    const b = { ...(req.body || {}) };
    let caseId = null;
    if (b.caseId != null) {
      const k = await prisma.clientCase.findFirst({ where: { id: parseId(b.caseId, "caseId"), clientId }, select: { id: true } });
      if (!k || (!isManager(req.user) && (!roles.get(k.id) || roles.get(k.id) === "result"))) throw badRequest("case is not this client's");
      caseId = k.id;
    }
    const mayRecordMoney = canSeeFinance(req.user) || (caseId != null && roles.get(caseId) === "coordinator");
    if (!mayRecordMoney) {
      if (b.kind !== undefined && b.kind !== CONSULTATION) throw financeForbidden();
      b.kind = CONSULTATION;
    }
    const data = cl.normalizePayment(b);
    let payment = await prisma.payment.create({ data: { ...data, clientId, caseId, recordedById: req.user.id } });
    await prisma.client.update({ where: { id: clientId }, data: { updatedAt: new Date() } });
    // A consultation fee: tie it to the client's appointment, so the
    // calendar shows it as paid.
    if (isConsultation(payment) && (await linkConsultationFees(prisma, clientId)) > 0) {
      payment = await prisma.payment.findUnique({ where: { id: payment.id } });
    }
    res.status(201).json(payment);
  } catch (err) {
    sendError(err, res, next);
  }
});

const payments = express.Router();
payments.use(requireAuth, gate, noLawyers);
// Removing a payment: managers — a contract payment only with Moliya.
payments.delete("/:id", managersOnly, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const payment = await prisma.payment.findUnique({ where: { id } });
    if (!payment || (!canSeeFinance(req.user) && !isConsultation(payment))) return res.status(404).json({ error: "not_found" });
    await prisma.$transaction([
      prisma.auditLog.create({ data: { userId: req.user.id, action: "payment.delete", entity: "payment", entityId: id, detail: { payment } } }),
      prisma.payment.delete({ where: { id } }),
    ]);
    res.status(204).end();
  } catch (err) {
    sendError(err, res, next);
  }
});

// ----------------------------------------------------------------- notes
const NOTE_CHANNELS = ["telegram", "meeting", "phone", "sms"];

// A note about the client, or about one of their cases (caseId) — a note
// on a case is seen by the people on that case only.
clients.post("/:id/notes", async (req, res, next) => {
  try {
    const clientId = parseId(req.params.id);
    await loadClient(clientId);
    const { roles, level } = await requireClientAccess(req.user, clientId, { write: true });
    const note = cl.text(req.body?.text, 4000);
    if (!note) throw badRequest("text is required");
    let caseId = null;
    if (req.body?.caseId != null) {
      caseId = parseId(req.body.caseId, "caseId");
      const k = await prisma.clientCase.findFirst({ where: { id: caseId, clientId }, select: { id: true } });
      if (!k || (level !== "manager" && (!roles.get(caseId) || roles.get(caseId) === "result"))) throw badRequest("case is not this client's");
    }
    // How the talk happened, when it wasn't in Ledger: a Telegram chat, a
    // meeting, a call from a personal phone, an SMS (null: just a note).
    const channel = NOTE_CHANNELS.includes(req.body?.channel) ? req.body.channel : null;
    const event = await prisma.clientEvent.create({
      data: { clientId, caseId, kind: "note", text: note, authorId: req.user.id, ...(channel ? { data: { channel } } : {}) },
      include: { author: PERSON },
    });
    await prisma.client.update({ where: { id: clientId }, data: { updatedAt: new Date() } });
    res.status(201).json(event);
  } catch (err) {
    sendError(err, res, next);
  }
});

const notes = express.Router();
notes.use(requireAuth, gate);

async function ownNote(req) {
  const event = await prisma.clientEvent.findUnique({ where: { id: parseId(req.params.id) } });
  if (!event || event.kind !== "note" || event.deletedAt) throw Object.assign(new Error("not_found"), { status: 404 });
  if (event.authorId !== req.user.id && !isManager(req.user)) throw Object.assign(new Error("forbidden"), { status: 403 });
  await requireClientAccess(req.user, event.clientId);
  return event;
}

// Correcting a note — your own, or any for a manager. It shows as edited;
// the words before go to the audit log.
notes.patch("/:id", async (req, res, next) => {
  try {
    const event = await ownNote(req);
    const text = cl.text(req.body?.text, 4000);
    if (!text) throw badRequest("text is required");
    if (text === event.text) return res.json(event);
    const [updated] = await prisma.$transaction([
      prisma.clientEvent.update({ where: { id: event.id }, data: { text, editedAt: new Date() }, include: { author: PERSON } }),
      prisma.auditLog.create({ data: { userId: req.user.id, action: "note.edit", entity: "client", entityId: event.clientId, detail: { noteId: event.id, before: event.text } } }),
    ]);
    res.json(updated);
  } catch (err) {
    sendError(err, res, next);
  }
});

// Removing a note — your own, or any for a manager. It's hidden, not
// deleted: the audit log keeps who removed what.
notes.delete("/:id", async (req, res, next) => {
  try {
    const event = await ownNote(req);
    await prisma.$transaction([
      prisma.clientEvent.update({ where: { id: event.id }, data: { deletedAt: new Date() } }),
      prisma.auditLog.create({ data: { userId: req.user.id, action: "note.delete", entity: "client", entityId: event.clientId, detail: { noteId: event.id, text: event.text, authorId: event.authorId, createdAt: event.createdAt } } }),
    ]);
    res.status(204).end();
  } catch (err) {
    sendError(err, res, next);
  }
});

// ----------------------------------------------------------- connections
// Connect this client with another — an existing one (otherId) or a new one
// (newClient: { name, phone }). direction "to": the other one is the
// referrer/"from" side (e.g. "recommended by"); default "from".
clients.post("/:id/links", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    await loadClient(id);
    await requireClientAccess(req.user, id, { write: true });
    const b = req.body || {};
    const kind = cl.oneOf(b.kind, cl.LINK_KINDS, "kind");
    if (!kind) throw badRequest("kind is required");
    const label = cl.text(b.label, 80);

    let otherId;
    if (b.otherId != null) {
      otherId = parseId(b.otherId, "otherId");
      await loadClient(otherId);
      await requireClientAccess(req.user, otherId);
    } else if (b.newClient?.name) {
      const phones = cl.normalizePhones(b.newClient.phone ? [b.newClient.phone] : []);
      const [clash] = await clientsByPhoneKeys(prisma, phones.map((p) => p.phoneKey));
      // The number belongs to someone else's client: say so, don't connect.
      if (clash && !(await accessibleClientIds(req.user, [clash.client.id])).has(clash.client.id)) {
        return res.status(409).json({ error: "phone_exists", client: (await clientIndexFor(req.user, [clash.phoneKey])).get(clash.phoneKey) });
      }
      if (clash) otherId = clash.client.id;
      else {
        const created = await prisma.client.create({
          data: {
            name: cl.text(b.newClient.name, 160),
            source: kind === "referral" && b.direction !== "to" ? "referral" : null,
            createdById: req.user.id,
            phones: { create: phones },
          },
        });
        await refreshSearch(prisma, created.id);
        otherId = created.id;
      }
    } else throw badRequest("otherId or newClient is required");
    if (otherId === id) throw badRequest("can't connect a client to themselves");

    const [fromId, toId] = b.direction === "to" ? [otherId, id] : [id, otherId];
    const link = await prisma.clientLink.upsert({
      where: { fromId_toId_kind: { fromId, toId, kind } },
      update: { label },
      create: { fromId, toId, kind, label },
    });
    res.status(201).json(link);
  } catch (err) {
    sendError(err, res, next);
  }
});

const links = express.Router();
links.use(requireAuth, gate, noLawyers);
links.delete("/:id", async (req, res, next) => {
  try {
    const link = await prisma.clientLink.findUnique({ where: { id: parseId(req.params.id) } });
    if (!link) return res.status(404).json({ error: "not_found" });
    const mine = await accessibleClientIds(req.user, [link.fromId, link.toId]);
    if (mine.size === 0) return res.status(404).json({ error: "not_found" });
    await prisma.clientLink.delete({ where: { id: link.id } });
    res.status(204).end();
  } catch (err) {
    sendError(err, res, next);
  }
});

// ------------------------------------------------------------------ bulk
// Many clients at once (managers): the ones ticked (ids), or every client the
// list's filters match (query). set — one of:
//   { operatorId } / { lawyerId }: on every case of each client;
//   { coordinatorId }: on each client's contract cases;
//   { status: "declined" }: "didn't continue" — closes their consultations
//   and "call again"s (contracts are left as they are; a consultation still
//   counts toward its operator's month).
const BULK_LIMIT = 2000;
clients.post("/bulk", managersOnly, async (req, res, next) => {
  try {
    const b = req.body || {};
    let ids;
    if (Array.isArray(b.ids)) ids = [...new Set(b.ids.map((x) => parseId(x, "ids")))];
    else if (b.query && typeof b.query === "object") {
      const { where } = await listQuery(b.query, req.user);
      ids = (await prisma.client.findMany({ where, select: { id: true }, take: BULK_LIMIT + 1 })).map((c) => c.id);
    } else throw badRequest("ids or query is required");
    if (ids.length > BULK_LIMIT) throw badRequest(`at most ${BULK_LIMIT} clients at once`);

    const set = b.set && typeof b.set === "object" ? b.set : {};
    const keys = Object.keys(set);
    if (keys.length !== 1 || !["operatorId", "lawyerId", "coordinatorId", "status"].includes(keys[0])) throw badRequest("set one of operatorId, lawyerId, coordinatorId, status");
    let data;
    let label;
    const where = { clientId: { in: ids } };
    if (keys[0] === "operatorId") {
      data = { operatorId: (await operatorFor(req, set.operatorId)) ?? null };
      label = data.operatorId ? (await prisma.employee.findUnique({ where: { id: data.operatorId }, select: { name: true } })).name : null;
    } else if (keys[0] === "lawyerId") {
      data = await lawyerFor(set.lawyerId, req);
      label = data.lawyer ?? null;
    } else if (keys[0] === "coordinatorId") {
      data = { coordinatorId: (await coordinatorFor(set.coordinatorId, req)) ?? null };
      label = data.coordinatorId ? (await prisma.employee.findUnique({ where: { id: data.coordinatorId }, select: { name: true } })).name : null;
      where.status = { in: CONTRACT_STATUSES };
    } else {
      if (set.status !== "declined") throw badRequest("status can only be declined");
      data = { status: "declined" };
      where.status = { in: ["consultation", "call_again"] };
    }

    const result = await prisma.$transaction(async (tx) => {
      const affected = ids.length ? await tx.clientCase.findMany({ where, select: { id: true, clientId: true, status: true } }) : [];
      if (affected.length) {
        await tx.clientCase.updateMany({ where: { id: { in: affected.map((k) => k.id) } }, data });
        if (data.status) {
          await tx.clientEvent.createMany({
            data: affected.map((k) => ({ clientId: k.clientId, caseId: k.id, kind: "status", text: `${k.status}>${data.status}`, authorId: req.user.id })),
          });
        }
      }
      const kindOf = { status: "declined", operatorId: "operator", lawyerId: "lawyer", coordinatorId: "coordinator" };
      if (keys[0] !== "status" && affected.length) {
        await tx.clientEvent.createMany({ data: affected.map((k) => ({ clientId: k.clientId, caseId: k.id, kind: "assign", text: "", data: { role: kindOf[keys[0]], to: label, bulk: true }, authorId: req.user.id })) });
      }
      const summary = { clients: ids.length, cases: affected.length, kind: kindOf[keys[0]], name: label };
      if (ids.length) await audit(tx, req, "clients.bulk", "client", null, summary);
      return summary;
    });
    res.json(result);
  } catch (err) {
    sendError(err, res, next);
  }
});

// ---------------------------------------------------------------- import
// Rows already read and interpreted by the portal (see the portal's
// lib/clientImport.js); here they're matched to existing clients by phone
// (then by name) and merged, or created. Send at most 200 rows at a time.
clients.post("/import", managersOnly, async (req, res, next) => {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || rows.length === 0) throw badRequest("rows are required");
    if (rows.length > 200) throw badRequest("at most 200 rows at a time");
    // Without Moliya, a sheet's contract amounts and payments are left out.
    const input = canSeeFinance(req.user) ? rows : rows.map((r) => (r && typeof r === "object" ? (({ contractAmount, paid, ...rest }) => rest)(r) : r));
    const result = await importer.importRows(prisma, input, { user: req.user, today: today() });
    await audit(prisma, req, "clients.import", "client", null, { rows: rows.length, created: result.created, updated: result.updated, skipped: result.skipped });
    res.json(result);
  } catch (err) {
    sendError(err, res, next);
  }
});

// A Google Sheets link -> the spreadsheet as an .xlsx file, for the portal
// to read like an uploaded one. Works for sheets shared "anyone with the link".
clients.get("/import/google", managersOnly, async (req, res, next) => {
  try {
    const url = String(req.query.url || "");
    const match = url.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
    if (!match) return res.status(400).json({ error: "not_a_google_sheet" });
    const response = await fetch(`https://docs.google.com/spreadsheets/d/${match[1]}/export?format=xlsx`, { redirect: "follow" });
    const type = response.headers.get("content-type") || "";
    if (!response.ok || !type.includes("spreadsheetml")) return res.status(409).json({ error: "sheet_not_shared" });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 15 * 1024 * 1024) return res.status(413).json({ error: "too_large" });
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(bytes);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------- audit log
// The latest changes that removed or reshaped data (managers): who, what,
// when, and which client it concerned.
const auditLog = express.Router();
auditLog.use(requireAuth, managersOnly);
auditLog.get("/", async (req, res, next) => {
  try {
    const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 100, include: { user: PERSON } });
    const clientIds = [...new Set(rows.map(auditClientId).filter(Boolean))];
    const names = new Map(
      (await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } })).map((c) => [c.id, c.name])
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        createdAt: r.createdAt,
        user: r.user,
        clientId: names.has(auditClientId(r)) ? auditClientId(r) : null,
        clientName: names.get(auditClientId(r)) || null,
        summary: auditSummary(r, canSeeFinance(req.user)),
      }))
    );
  } catch (err) {
    next(err);
  }
});

// Which client an entry concerns: the client itself, or the one a deleted
// case or payment belonged to.
function auditClientId(r) {
  if (r.entity === "client") return r.entityId;
  return r.detail?.case?.clientId ?? r.detail?.payment?.clientId ?? null;
}

// A short, safe description of what an entry changed (not the whole copy).
function auditSummary(r, money = true) {
  const d = r.detail || {};
  if (r.action === "clients.import") return { created: d.created, updated: d.updated, skipped: d.skipped };
  if (r.action === "client.merge") return { merged: d.merged?.name || null };
  if (r.action === "case.delete") return { matter: d.case?.matter || null, payments: d.case?.payments?.length || 0 };
  if (r.action === "payment.delete") return { amount: money || d.payment?.kind === CONSULTATION ? d.payment?.amount ?? null : null };
  if (r.action === "clients.bulk") return { clients: d.clients, cases: d.cases, kind: d.kind, name: d.name ?? null };
  if (r.entity === "material") return { title: d.title ?? null, file: d.name ?? null };
  return {};
}

module.exports = { clients, cases, payments, notes, links, auditLog, canUseClients };
