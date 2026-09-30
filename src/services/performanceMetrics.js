const prisma = require("../lib/prisma");

// What a person can be measured on (Natijalar), and their targets.
//
// Built-in measures — for people who work with clients (call center,
// booking consultations):
//   calls_answered  answered calls on their phone
//   bookings        consultations they put in the calendar
//   consultations   their cases whose consultation date is this month
//   contracts       their cases signed this month
//   fees            consultation fees from their clients (soʻm)
//
// Report measures — for everyone who fills in a daily report form: each
// number or money question (and each number/money column of a table
// question) is a measure, added up over the month: "report:<form id>:
// <question id>" or "report:<form id>:<question id>:<column id>". So a
// translator's "documents translated", a clerk's "people served" or
// "money taken" are measured like consultations are for the call center.
//
// Targets (Target) are per person, per measure, from a month on. The
// position's consultations / contracts targets stay the default for people
// without their own.

const BUILTIN = ["consultations", "contracts", "bookings", "calls_answered", "fees"];
const MONEY = new Set(["fees"]);
const NUMERIC = ["number", "money"];

const reportKey = (templateId, fieldId, columnId) => (columnId ? `report:${templateId}:${fieldId}:${columnId}` : `report:${templateId}:${fieldId}`);

function parseKey(key) {
  if (BUILTIN.includes(key)) return { builtin: key };
  const m = /^report:(\d+):([A-Za-z0-9_-]{1,40})(?::([A-Za-z0-9_-]{1,40}))?$/.exec(String(key || ""));
  return m ? { templateId: Number(m[1]), fieldId: m[2], columnId: m[3] || null } : null;
}

// The measures a form offers: its number/money questions and columns.
function formMeasures(template) {
  const out = [];
  for (const f of Array.isArray(template?.fields) ? template.fields : []) {
    if (NUMERIC.includes(f.type)) out.push({ key: reportKey(template.id, f.id), label: f.label, unit: f.type === "money" ? "money" : "count", form: template.name });
    if (f.type === "table") {
      for (const c of f.columns || []) {
        if (NUMERIC.includes(c.type)) out.push({ key: reportKey(template.id, f.id, c.id), label: `${f.label} → ${c.label}`, unit: c.type === "money" ? "money" : "count", form: template.name });
      }
    }
  }
  return out;
}

// Report measures added up from reports: key -> { total, byDate: Map,
// groups: Map name -> total (a table's rows by their service column) }.
function reportValues(reports) {
  const values = new Map();
  const slot = (key) => {
    if (!values.has(key)) values.set(key, { total: 0, byDate: new Map(), groups: new Map() });
    return values.get(key);
  };
  const add = (key, date, amount, group) => {
    if (!Number.isFinite(amount) || amount === 0) return;
    const v = slot(key);
    v.total += amount;
    v.byDate.set(date, (v.byDate.get(date) || 0) + amount);
    if (group) v.groups.set(group, (v.groups.get(group) || 0) + amount);
  };
  for (const r of reports) {
    for (const f of Array.isArray(r.fields) ? r.fields : []) {
      const value = r.answers?.[f.id];
      if (value === undefined || value === null) continue;
      if (NUMERIC.includes(f.type)) add(reportKey(r.templateId, f.id), r.date, Number(value));
      if (f.type === "table" && Array.isArray(value)) {
        const cols = f.columns || [];
        const by = cols.find((c) => c.type === "select") || cols.find((c) => c.type === "text");
        for (const row of value) {
          const group = by && typeof row?.[by.id] === "string" && row[by.id].trim() ? row[by.id].trim() : null;
          for (const c of cols) if (NUMERIC.includes(c.type)) add(reportKey(r.templateId, f.id, c.id), r.date, Number(row?.[c.id]), group);
        }
      }
    }
  }
  return values;
}

// Each person's targets in `month`: employeeId -> Map metric -> amount. The
// position's consultations/contracts targets fill in where the person has
// no entry of their own (an entry of 0 means "no target").
async function targetsFor(employees, month, db = prisma) {
  const rows = await db.target.findMany({
    where: { employeeId: { in: employees.map((e) => e.id) }, fromMonth: { lte: month } },
    orderBy: { fromMonth: "desc" },
    select: { employeeId: true, metric: true, amount: true },
  });
  const map = new Map(employees.map((e) => [e.id, new Map()]));
  const seen = new Set();
  for (const r of rows) {
    const k = `${r.employeeId}|${r.metric}`;
    if (seen.has(k)) continue;
    seen.add(k);
    map.get(r.employeeId)?.set(r.metric, r.amount);
  }
  for (const e of employees) {
    const mine = map.get(e.id);
    const pos = e.position || {};
    if (!mine.has("consultations") && pos.targetConsultations) mine.set("consultations", pos.targetConsultations);
    if (!mine.has("contracts") && pos.targetContracts) mine.set("contracts", pos.targetContracts);
    for (const [k, v] of mine) if (!(v > 0)) mine.delete(k);
  }
  return map;
}

// The measures to offer when setting someone's target: built-ins for client
// work, and the questions of their report form (and any form they already
// have a target from).
async function catalogFor(employee, db = prisma) {
  // Same rule as the performance page (services/performance.js), unless the
  // developer settled it (workKind).
  const autoOnly = employee.autoReport && !employee.alsoForm;
  const kind = employee.workKind || "auto";
  const clientWork = kind === "client" || (kind === "auto" && (employee.calendarAccess === "book" || (employee.collectCalls && autoOnly)));
  // Calls only for people whose calls are collected.
  const builtin = (clientWork ? BUILTIN.filter((k) => k !== "calls_answered" || employee.collectCalls) : []).map((key) => ({ key, builtin: true, unit: MONEY.has(key) ? "money" : "count" }));
  const own = await db.target.findMany({ where: { employeeId: employee.id }, select: { metric: true } });
  const asksForm = employee.reportTemplateId && (!employee.autoReport || employee.alsoForm);
  const templateIds = new Set([asksForm ? employee.reportTemplateId : null, ...own.map((t) => parseKey(t.metric)?.templateId)].filter(Boolean));
  const templates = templateIds.size ? await db.reportTemplate.findMany({ where: { id: { in: [...templateIds] } }, select: { id: true, name: true, fields: true } }) : [];
  return [...builtin, ...templates.flatMap(formMeasures)];
}

module.exports = { BUILTIN, MONEY, parseKey, reportKey, formMeasures, reportValues, targetsFor, catalogFor };
