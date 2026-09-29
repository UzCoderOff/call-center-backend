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
const { canSeeFinance, financeForbidden, caseWithoutMoney, visiblePayments, isConsultation, CONSULTATION } = require("../lib/finance");
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
// Who: managers, and staff who deal with clients — call-center staff and
// anyone who books appointments. Archiving, merging, deleting cases/payments,
// importing and exporting: managers only — each recorded in the audit log.
// Lawyers (LAWYER accounts) see only their own clients — those with a case
// assigned to them — and only their own cases of those; they can move their
// cases along and write notes, nothing else.
//
// Contract money — contract amounts, contract payments, debts — only for the
// DEVELOPER and accounts with the "Moliya" switch (src/lib/finance.js):
// everyone else gets none of it in any answer, and a contract amount they
// send is ignored (so editing a case they can't see the amount of never
// erases it). The consultation fee is the exception: staff see it and record
// it (they check it before booking the client in).

function canUseClients(user) {
  return isManager(user) || isLawyer(user) || Boolean(user.employee?.collectCalls || user.employee?.calendarAccess === "book");
}
function gate(req, res, next) {
  if (!canUseClients(req.user)) return res.status(403).json({ error: "forbidden" });
  next();
}
// What a lawyer may do here; everything else is closed to them.
function lawyerGate(req, res, next) {
  if (!isLawyer(req.user)) return next();
  const allowed = (req.method === "GET" && /^\/(\d+)?$/.test(req.path)) || (req.method === "POST" && /^\/\d+\/notes$/.test(req.path));
  if (!allowed) return res.status(403).json({ error: "forbidden" });
  next();
}
function noLawyers(req, res, next) {
  if (isLawyer(req.user)) return res.status(403).json({ error: "forbidden" });
  next();
}
// A lawyer's own client: at least one case assigned to them.
async function isLawyersClient(user, clientId) {
  return (await prisma.clientCase.count({ where: { clientId, lawyerId: user.id } })) > 0;
}
function managersOnly(req, res, next) {
  if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
  next();
}

const PAGE_SIZE = 30;
const PERSON = { select: { id: true, username: true, employee: { select: { name: true } } } };
const today = () => firmNow().date;

function sendError(err, res, next) {
  if (err instanceof cl.ClientError) return res.status(400).json({ error: err.message });
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
  if (b.nextCallAt !== undefined) {
    if (b.nextCallAt === null || b.nextCallAt === "") data.nextCallAt = null;
    else {
      const when = new Date(b.nextCallAt);
      if (Number.isNaN(when.getTime())) throw badRequest("invalid nextCallAt");
      data.nextCallAt = when;
    }
  }
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

// Case numbers with the payment summary the portal shows.
function withMoney(c) {
  return { ...c, ...cl.paymentSummary(c.contractAmount, c.payments || []) };
}

// ------------------------------------------------------------------ list
const clients = express.Router();
clients.use(requireAuth, gate, lawyerGate);

// Two sections, so ongoing work isn't buried under one-off consultations:
//   ?section=clients        clients with a contract (or a finished case)
//   ?section=consultations  everyone else — consultations, "call again", declined
// (no section: everyone, e.g. when searching). A lawyer: by their own cases.
const CONTRACT_STATUSES = ["contract", "done"];
function sectionWhere(section, user) {
  const own = isLawyer(user) ? { lawyerId: user.id } : {};
  if (section === "clients") return { cases: { some: { ...own, status: { in: CONTRACT_STATUSES } } } };
  if (section === "consultations") return { cases: { none: { ...own, status: { in: CONTRACT_STATUSES } } } };
  return null;
}

// ?q= name / phone / case number (Latin or Cyrillic) · ?filter= callToday |
// debt | active | archived (managers) · ?status= · ?legalStage= ·
// ?operatorId= · ?lawyerId= · ?lawyer=  — archived clients only appear under
// "archived". A lawyer: only clients with a case of theirs, filtered by those.
async function listQuery(q, user) {
  const and = [q.filter === "archived" && isManager(user) ? { archivedAt: { not: null } } : { archivedAt: null }];
  if (isLawyer(user)) and.push({ cases: { some: { lawyerId: user.id } } });
  for (const word of cl.searchable(q.q || "").split(" ").filter(Boolean)) {
    and.push({ searchText: { contains: word } });
  }
  const caseWhere = {};
  if (q.status) caseWhere.status = cl.oneOf(q.status, cl.STATUSES, "status");
  if (q.legalStage) caseWhere.legalStage = cl.oneOf(q.legalStage, cl.LEGAL_STAGES, "legalStage");
  // "none": cases nobody is assigned to yet — to find and fill in.
  if (q.operatorId) caseWhere.operatorId = q.operatorId === "none" ? null : parseId(q.operatorId, "operatorId");
  if (q.lawyerId) caseWhere.lawyerId = q.lawyerId === "none" ? null : parseId(q.lawyerId, "lawyerId");
  if (q.lawyer) caseWhere.lawyer = String(q.lawyer);
  if (q.filter === "active") caseWhere.status = caseWhere.status || { in: cl.OPEN_STATUSES };
  if (isLawyer(user) && Object.keys(caseWhere).length > 0) caseWhere.lawyerId = user.id;
  if (Object.keys(caseWhere).length > 0) and.push({ cases: { some: caseWhere } });

  let orderBy = [{ updatedAt: "desc" }];
  if (q.filter === "callToday") {
    and.push({ nextCallAt: { not: null, lte: new Date(firmDayRange(today()).to) } });
    orderBy = [{ nextCallAt: "asc" }];
  }
  if (q.filter === "debt") {
    if (!canSeeFinance(user)) throw financeForbidden();
    and.push({ id: { in: await clientIdsWithDebt(isLawyer(user) ? user.id : null) } });
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

clients.get("/", async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const money = canSeeFinance(req.user);
    const { where, orderBy } = await listQuery(req.query, req.user);
    // How many each section has with the same filters — for the tabs.
    const sectionCount = async (section) => prisma.client.count({ where: (await listQuery({ ...req.query, section }, req.user)).where });
    const sections = req.query.section ? { clients: await sectionCount("clients"), consultations: await sectionCount("consultations") } : null;
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
              contractAmount: money,
              operator: { select: { id: true, name: true } },
              ...(money ? { payments: { select: { amount: true } } } : {}),
            },
          },
        },
      }),
      prisma.client.count({ where }),
    ]);

    res.json({
      clients: rows.map(({ phones, cases, searchText, extra, ...c }) => ({
        ...c,
        phone: phones[0]?.phone || null,
        latestCase: cases[0] ? (({ payments, ...k }) => k)(cases[0]) : null,
        caseCount: cases.length,
        ...(money ? { debt: cases.reduce((sum, k) => sum + cl.paymentSummary(k.contractAmount, k.payments).remaining, 0) } : {}),
      })),
      pagination: { page, pageSize: PAGE_SIZE, total, totalPages: Math.ceil(total / PAGE_SIZE) },
      ...(sections ? { sections } : {}),
    });
  } catch (err) {
    sendError(err, res, next);
  }
});

async function clientIdsWithDebt(lawyerId = null) {
  const cases = await prisma.clientCase.findMany({
    where: { contractAmount: { gt: 0 }, ...(lawyerId ? { lawyerId } : {}) },
    select: { clientId: true, contractAmount: true, payments: { select: { amount: true } } },
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
        cases: { orderBy: { createdAt: "asc" }, include: { operator: { select: { name: true } }, payments: { select: { amount: true } } } },
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
    const rows = await clientsByPhoneKeys(prisma, [key]);
    res.json(rows.map((r) => r.client));
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
      if (clash.length > 0) return res.status(409).json({ error: "phone_exists", client: clash[0].client });
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

// One client, with everything the client page shows: phones, cases (with
// payments and money summary), connections, the timeline's notes, and the
// calls and appointments found through their phone numbers.
clients.get("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const lawyer = isLawyer(req.user);
    if (lawyer && !(await isLawyersClient(req.user, id))) return res.status(404).json({ error: "not_found" });
    const client = await prisma.client.findUnique({
      where: { id },
      include: {
        phones: { orderBy: { id: "asc" } },
        createdBy: PERSON,
        cases: {
          orderBy: { createdAt: "desc" },
          include: { operator: { select: { id: true, name: true } }, payments: { orderBy: { date: "desc" } } },
        },
        payments: { orderBy: [{ date: "desc" }, { id: "desc" }], include: { recordedBy: PERSON } },
        events: { orderBy: { createdAt: "desc" }, take: 300, include: { author: PERSON } },
        linksFrom: { include: { to: { include: LINKED } } },
        linksTo: { include: { from: { include: LINKED } } },
      },
    });
    if (!client) return res.status(404).json({ error: "not_found" });

    const keys = client.phones.map((p) => p.phoneKey).filter(Boolean);
    // Same rule as the calls list: managers see all; staff their own calls
    // only; a lawyer none.
    const callAccess = isManager(req.user) ? {} : { employeeId: req.user.employee?.id ?? -1 };
    const [calls, appointments] = await Promise.all([
      keys.length && !lawyer
        ? prisma.callLog.findMany({
            where: { phoneKey: { in: keys }, ...callAccess },
            orderBy: { callTimestampMs: "desc" },
            take: 100,
            select: {
              id: true,
              callType: true,
              missed: true,
              followUp: true,
              callTimestampMs: true,
              durationSeconds: true,
              recordingPath: true,
              employee: { select: { id: true, name: true } },
            },
          })
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

    const { linksFrom, linksTo, searchText, extra, ...rest } = client;
    // A lawyer sees their own cases (and those cases' history, plus notes
    // about the client), not the rest of the file. Money: only with Moliya.
    const ownCases = lawyer ? client.cases.filter((k) => k.lawyerId === req.user.id) : client.cases;
    const ownIds = new Set(ownCases.map((k) => k.id));
    const money = canSeeFinance(req.user);
    res.json({
      ...rest,
      cases: ownCases.map((k) => (money ? withMoney(k) : caseWithoutMoney(k))),
      payments: visiblePayments(req.user, lawyer ? client.payments.filter((p) => ownIds.has(p.caseId)) : client.payments),
      finance: money,
      events: lawyer ? client.events.filter((e) => e.caseId == null ? e.kind === "note" : ownIds.has(e.caseId)) : client.events,
      links: lawyer
        ? []
        : [
            ...linksFrom.map((l) => ({ id: l.id, kind: l.kind, label: l.label, direction: "from", other: linkedSummary(l.to) })),
            ...linksTo.map((l) => ({ id: l.id, kind: l.kind, label: l.label, direction: "to", other: linkedSummary(l.from) })),
          ],
      calls: calls.map(({ recordingPath, ...c }) => ({ ...c, hasRecording: Boolean(recordingPath) })),
      appointments,
      canManage: isManager(req.user),
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
    const b = req.body || {};
    const data = clientFields(b);
    const phones = cl.normalizePhones(b.phones);
    if (phones && b.force !== true) {
      const clash = await clientsByPhoneKeys(prisma, phones.map((p) => p.phoneKey), { exceptId: id });
      if (clash.length > 0) return res.status(409).json({ error: "phone_exists", client: clash[0].client });
    }
    const client = await prisma.$transaction(async (tx) => {
      const updated = await tx.client.update({ where: { id }, data });
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
      for (const model of ["clientCase", "payment", "clientEvent", "appointment"]) {
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
      if (Object.keys(fill).length) await tx.client.update({ where: { id }, data: fill });
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

// What a lawyer may change on a case of theirs: where it stands.
const LAWYER_CASE_FIELDS = ["status", "legalStage", "number", "matter"];

// Status and stage changes are written to the client's timeline.
cases.patch("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const current = await prisma.clientCase.findUnique({ where: { id } });
    if (!current) return res.status(404).json({ error: "not_found" });
    let b = caseInput(req, req.body);
    if (isLawyer(req.user)) {
      if (current.lawyerId !== req.user.id) return res.status(404).json({ error: "not_found" });
      if (Object.keys(b).some((k) => !LAWYER_CASE_FIELDS.includes(k))) return res.status(403).json({ error: "forbidden" });
      b = Object.fromEntries(Object.entries(b).filter(([k]) => LAWYER_CASE_FIELDS.includes(k)));
    }
    const data = cl.normalizeCase(b, current, today());
    const operatorId = await operatorFor(req, b.operatorId, current.operatorId);
    if (operatorId !== undefined) data.operatorId = operatorId;
    const lawyer = await lawyerFor(b.lawyerId, req, current.lawyerId);
    if (lawyer) Object.assign(data, lawyer);
    const updated = await prisma.$transaction(async (tx) => {
      const c = await tx.clientCase.update({ where: { id }, data });
      const log = (kind, from, to) =>
        tx.clientEvent.create({ data: { clientId: c.clientId, caseId: id, kind, text: `${from || ""}>${to || ""}`, authorId: req.user.id } });
      if (data.status && data.status !== current.status) await log("status", current.status, data.status);
      if (data.legalStage !== undefined && data.legalStage !== current.legalStage) await log("stage", current.legalStage, data.legalStage);
      if (data.number !== undefined) await refreshSearch(tx, c.clientId);
      await tx.client.update({ where: { id: c.clientId }, data: { updatedAt: new Date() } });
      return c;
    });
    res.json(canSeeFinance(req.user) ? updated : caseWithoutMoney(updated));
  } catch (err) {
    sendError(err, res, next);
  }
});

cases.delete("/:id", managersOnly, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const c = await prisma.clientCase.findUnique({ where: { id }, include: { payments: true } });
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
// consultation fee; any other payment only people who see money.
clients.post("/:id/payments", async (req, res, next) => {
  try {
    const clientId = parseId(req.params.id);
    await loadClient(clientId);
    const b = { ...(req.body || {}) };
    if (!canSeeFinance(req.user)) {
      if (b.kind !== undefined && b.kind !== CONSULTATION) throw financeForbidden();
      b.kind = CONSULTATION;
    }
    const data = cl.normalizePayment(b);
    let caseId = null;
    if (b.caseId != null) {
      const k = await prisma.clientCase.findFirst({ where: { id: parseId(b.caseId, "caseId"), clientId }, select: { id: true } });
      if (!k) throw badRequest("case is not this client's");
      caseId = k.id;
    }
    const payment = await prisma.payment.create({ data: { ...data, clientId, caseId, recordedById: req.user.id } });
    await prisma.client.update({ where: { id: clientId }, data: { updatedAt: new Date() } });
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
clients.post("/:id/notes", async (req, res, next) => {
  try {
    const clientId = parseId(req.params.id);
    await loadClient(clientId);
    if (isLawyer(req.user) && !(await isLawyersClient(req.user, clientId))) return res.status(404).json({ error: "not_found" });
    const note = cl.text(req.body?.text, 4000);
    if (!note) throw badRequest("text is required");
    const event = await prisma.clientEvent.create({
      data: { clientId, kind: "note", text: note, authorId: req.user.id },
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
// Your own note, or any note for a manager.
notes.delete("/:id", async (req, res, next) => {
  try {
    const event = await prisma.clientEvent.findUnique({ where: { id: parseId(req.params.id) } });
    if (!event || event.kind !== "note") return res.status(404).json({ error: "not_found" });
    if (event.authorId !== req.user.id && !isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    await prisma.clientEvent.delete({ where: { id: event.id } });
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
    const b = req.body || {};
    const kind = cl.oneOf(b.kind, cl.LINK_KINDS, "kind");
    if (!kind) throw badRequest("kind is required");
    const label = cl.text(b.label, 80);

    let otherId;
    if (b.otherId != null) {
      otherId = parseId(b.otherId, "otherId");
      await loadClient(otherId);
    } else if (b.newClient?.name) {
      const phones = cl.normalizePhones(b.newClient.phone ? [b.newClient.phone] : []);
      const [clash] = await clientsByPhoneKeys(prisma, phones.map((p) => p.phoneKey));
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
    await prisma.clientLink.delete({ where: { id: parseId(req.params.id) } });
    res.status(204).end();
  } catch (err) {
    sendError(err, res, next);
  }
});

// ------------------------------------------------------------------ bulk
// Many clients at once (managers): the ones ticked (ids), or every client the
// list's filters match (query). set — one of:
//   { operatorId } / { lawyerId }: on every case of each client;
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
    if (keys.length !== 1 || !["operatorId", "lawyerId", "status"].includes(keys[0])) throw badRequest("set one of operatorId, lawyerId, status");
    let data;
    let label;
    const where = { clientId: { in: ids } };
    if (keys[0] === "operatorId") {
      data = { operatorId: (await operatorFor(req, set.operatorId)) ?? null };
      label = data.operatorId ? (await prisma.employee.findUnique({ where: { id: data.operatorId }, select: { name: true } })).name : null;
    } else if (keys[0] === "lawyerId") {
      data = await lawyerFor(set.lawyerId, req);
      label = data.lawyer ?? null;
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
      const summary = { clients: ids.length, cases: affected.length, kind: keys[0] === "status" ? "declined" : keys[0] === "operatorId" ? "operator" : "lawyer", name: label };
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
