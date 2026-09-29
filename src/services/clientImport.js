const cl = require("./clients");
const { refreshSearch, clientsByPhoneKeys } = require("../lib/clientsDb");
const { lawyerAccounts, matchLawyer } = require("../lib/lawyers");

// Importing clients from a spreadsheet. The portal reads the file and turns
// each row into { name, phones[], city, email, source, matter, lawyer,
// number, status, legalStage, startDate, contractDate, contractAmount, paid,
// nextCallAt, notes[], operatorId, clientId, sheet, row }. Here each row is
// matched to an existing client (see findClient) and merged in, or created.
// Importing the same file twice changes nothing — nor does importing a file
// exported from here.
//
// Merging never loses information: empty fields get filled, a case's status
// and legal stage only move forward, a "paid" total becomes a payment for
// whatever isn't recorded yet, and notes already on the timeline aren't added
// again. A lawyer's name that names exactly one lawyer account ("Karimov A."
// -> the account "Advokat Karimov") assigns the case to that account, so the
// lawyer sees it.

const STATUS_RANK = { declined: -1, call_again: 0, consultation: 1, contract: 2, done: 3 };
const EXAMPLE_ROW = /\((мисол|misol|пример|example)\)/i;

// Invalid values from a sheet are dropped, not fatal: one odd cell shouldn't
// cost the whole row.
function safe(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

// The same person: a file exported from here names each client's ID — that
// client, as long as the name matches too (so a stray "ID" or row-number
// column in some other spreadsheet can't attach a row to the wrong person).
// Otherwise the same phone number. Only a row without any number is matched
// by name — and only when exactly one client has exactly that name, so two
// different people who share a name are never merged.
async function findClient(tx, name, phones, id) {
  if (Number.isInteger(id) && id > 0) {
    const byId = await tx.client.findUnique({ where: { id }, include: { phones: true } });
    if (byId && cl.searchable(byId.name) === cl.searchable(name)) return byId;
  }
  const [byPhone] = await clientsByPhoneKeys(tx, phones.map((p) => p.phoneKey));
  if (byPhone) return tx.client.findUnique({ where: { id: byPhone.client.id }, include: { phones: true } });
  if (phones.some((p) => p.phoneKey)) return null;
  const key = cl.searchable(name);
  if (!key) return null;
  const candidates = await tx.client.findMany({
    where: { searchText: { startsWith: key } },
    include: { phones: true },
    take: 20,
  });
  const same = candidates.filter((c) => cl.searchable(c.name) === key);
  return same.length === 1 ? same[0] : null;
}

async function importOne(tx, raw, { user, today, operators, lawyers }) {
  // A "name" without a single letter ("0", "-") is noise, not a person.
  const name = /\p{L}/u.test(raw.name || "") ? cl.text(raw.name, 160) : null;
  const phones = safe(() => cl.normalizePhones((raw.phones || []).slice(0, 5))) || [];
  if (!name && phones.length === 0) return "skipped";
  if (name && EXAMPLE_ROW.test(name)) return "skipped";

  const fields = {
    city: cl.text(raw.city, 80),
    email: cl.text(raw.email, 160),
    source: safe(() => cl.oneOf(raw.source, cl.SOURCES, "source")) || null,
  };
  const nextCallAt = raw.nextCallAt && !Number.isNaN(new Date(raw.nextCallAt).getTime()) ? new Date(raw.nextCallAt) : null;

  let client = await findClient(tx, name || phones[0].phone, phones, Number(raw.clientId));
  let outcome = "updated";
  if (!client) {
    client = await tx.client.create({
      data: {
        name: name || phones[0].phone,
        ...fields,
        nextCallAt,
        createdById: user.id,
        phones: { create: phones },
      },
      include: { phones: true },
    });
    outcome = "created";
  } else {
    const have = new Set(client.phones.map((p) => p.phoneKey).filter(Boolean));
    const extra = phones.filter((p) => !p.phoneKey || !have.has(p.phoneKey));
    const fill = {};
    for (const [key, value] of Object.entries(fields)) if (value && !client[key]) fill[key] = value;
    if (nextCallAt && (!client.nextCallAt || nextCallAt > client.nextCallAt)) fill.nextCallAt = nextCallAt;
    if (Object.keys(fill).length) await tx.client.update({ where: { id: client.id }, data: fill });
    if (extra.length && client.phones.length + extra.length <= 5) {
      await tx.clientPhone.createMany({ data: extra.map((p) => ({ ...p, clientId: client.id })) });
    }
  }

  const caseId = await importCase(tx, client.id, raw, { user, today, operators, lawyers });
  await importNotes(tx, client.id, caseId, raw.notes, user, client.notes);
  await refreshSearch(tx, client.id);
  return outcome;
}

// Which of the client's cases a row is about. The same case number is
// certain. Otherwise a case that doesn't contradict the row (a different
// number or a different matter means a different case), preferring the same
// matter, then the same start date, then the same status, then the most
// recently worked on — so a client with several cases, exported and imported
// back, gets each row onto its own case.
async function findCase(tx, clientId, row) {
  const cases = await tx.clientCase.findMany({ where: { clientId }, orderBy: { updatedAt: "desc" } });
  if (row.number) {
    const same = cases.find((c) => c.number === row.number);
    if (same) return same;
  }
  const matter = cl.searchable(row.matter);
  let best = null;
  let bestScore = -1;
  for (const c of cases) {
    if (row.number && c.number) continue;
    const caseMatter = cl.searchable(c.matter);
    // "Meros" and "Meros masalasi" are the same matter, written twice.
    const alike = matter && caseMatter && (caseMatter.includes(matter) || matter.includes(caseMatter));
    if (matter && caseMatter && !alike) continue;
    const score =
      (alike ? (caseMatter === matter ? 4 : 3) : 0) + (row.startDate && c.startDate === row.startDate ? 2 : 0) + (row.status && c.status === row.status ? 1 : 0);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

async function importCase(tx, clientId, raw, { user, today, operators, lawyers }) {
  const status = safe(() => cl.oneOf(raw.status, cl.STATUSES, "status")) || null;
  const legalStage = safe(() => cl.oneOf(raw.legalStage, cl.LEGAL_STAGES, "legalStage")) || null;
  const startDate = safe(() => cl.date(raw.startDate, "startDate")) || null;
  const contractDate = safe(() => cl.date(raw.contractDate, "contractDate")) || null;
  const contractAmount = safe(() => cl.amount(raw.contractAmount, "contractAmount")) || null;
  const paid = safe(() => cl.amount(raw.paid, "paid")) || 0;
  const operatorId = raw.operatorId && operators.has(Number(raw.operatorId)) ? Number(raw.operatorId) : null;
  // The lawyer the importer confirmed on the import screen (lawyerId: an
  // account, or null for "just the name"); otherwise the name matched
  // against the accounts.
  const lawyerAccount =
    raw.lawyerId !== undefined
      ? raw.lawyerId == null
        ? null
        : lawyers.find((l) => l.id === Number(raw.lawyerId)) || null
      : matchLawyer(raw.lawyer, lawyers);
  const text = {
    matter: cl.text(raw.matter, 500),
    number: cl.text(raw.number, 80),
    lawyer: cl.text(raw.lawyer, 120),
  };
  const hasCase = status || legalStage || contractAmount || paid || text.matter || text.number || text.lawyer || startDate;
  if (!hasCase) return null;

  const existing = await findCase(tx, clientId, { ...text, status, startDate });

  let caseRow;
  if (!existing) {
    const data = cl.normalizeCase(
      { ...text, status: status || (legalStage ? "contract" : "consultation"), legalStage, startDate: startDate || contractDate || today, contractDate, contractAmount },
      {},
      today
    );
    // Dates from the sheet, not the day of the import.
    if (data.contractDate === today && contractDate == null && startDate) data.contractDate = startDate;
    // A row with no date at all is history of unknown date: it doesn't count
    // toward this month's (or any month's) targets.
    if (!startDate && !contractDate) Object.assign(data, { startDate: null, consultationDate: null, contractDate: null });
    const assigned = lawyerAccount ? { lawyerId: lawyerAccount.id, lawyer: lawyerAccount.name } : {};
    caseRow = await tx.clientCase.create({ data: { ...data, clientId, operatorId, ...assigned } });
  } else {
    const update = {};
    for (const [key, value] of Object.entries(text)) if (value && !existing[key]) update[key] = value;
    if (contractAmount && !existing.contractAmount) update.contractAmount = contractAmount;
    if (!existing.operatorId && operatorId) update.operatorId = operatorId;
    if (!existing.lawyerId && lawyerAccount) Object.assign(update, { lawyerId: lawyerAccount.id, lawyer: lawyerAccount.name });
    const newStatus = status || (legalStage ? "contract" : null);
    if (newStatus && (STATUS_RANK[newStatus] ?? -1) > (STATUS_RANK[existing.status] ?? -1)) update.status = newStatus;
    if (legalStage && cl.LEGAL_STAGES.indexOf(legalStage) > cl.LEGAL_STAGES.indexOf(existing.legalStage)) update.legalStage = legalStage;
    // Moved forward by the sheet: dated from the sheet or the case itself —
    // never "today" (that would count old work toward this month's targets).
    const dates = cl.normalizeCase({ status: update.status }, existing, today);
    const consultedOn = startDate || existing.startDate;
    const signedOn = contractDate || startDate || existing.startDate;
    if (dates.consultationDate && consultedOn) update.consultationDate = consultedOn;
    if (dates.contractDate && signedOn) update.contractDate = signedOn;
    caseRow = Object.keys(update).length ? await tx.clientCase.update({ where: { id: existing.id }, data: update }) : existing;
  }

  // "Paid so far" in the sheet -> a payment for what isn't recorded yet.
  if (paid > 0) {
    const recorded = await tx.payment.aggregate({ where: { caseId: caseRow.id }, _sum: { amount: true } });
    const missing = paid - (recorded._sum.amount || 0);
    if (missing > 0) {
      await tx.payment.create({
        data: {
          clientId,
          caseId: caseRow.id,
          amount: missing,
          date: caseRow.contractDate || caseRow.startDate || today,
          kind: caseRow.status === "consultation" ? "consultation" : "contract",
          note: "Excel",
          recordedById: user.id,
        },
      });
    }
  }
  return caseRow.id;
}

// A note is "Column title: text". It isn't added again if the timeline
// already has it, or if the text is the client's own notes (an exported
// file's notes column, imported back).
async function importNotes(tx, clientId, caseId, notes, user, clientNotes) {
  const texts = (Array.isArray(notes) ? notes : []).map((n) => cl.text(n, 4000)).filter(Boolean);
  if (texts.length === 0) return;
  const existing = await tx.clientEvent.findMany({ where: { clientId, kind: "import" }, select: { text: true } });
  const seen = new Set(existing.map((e) => e.text));
  const own = String(clientNotes || "").trim();
  for (const text of texts) {
    if (seen.has(text)) continue;
    if (own && text.slice(text.indexOf(":") + 1).trim() === own) continue;
    seen.add(text);
    await tx.clientEvent.create({ data: { clientId, caseId, kind: "import", text, authorId: user.id } });
  }
}

async function importRows(db, rows, { user, today }) {
  const operators = new Set((await db.employee.findMany({ select: { id: true } })).map((e) => e.id));
  const lawyers = await lawyerAccounts(db);
  const result = { created: 0, updated: 0, skipped: 0, problems: [] };
  let done = 0;
  for (const raw of rows) {
    // A short breath every few rows: SQLite has one writer at a time, and a
    // phone syncing its calls or someone booking shouldn't wait behind a
    // whole spreadsheet.
    done += 1;
    if (done % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 60));
    try {
      const outcome = await db.$transaction((tx) => importOne(tx, raw || {}, { user, today, operators, lawyers }));
      result[outcome] += 1;
    } catch (err) {
      result.skipped += 1;
      result.problems.push({ sheet: raw?.sheet ?? null, row: raw?.row ?? null, error: err.message });
    }
  }
  return result;
}

module.exports = { importRows };
