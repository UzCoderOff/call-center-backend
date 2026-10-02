// Money written in staff daily reports, for the Moliya page.
//
// Only money questions (and money columns of table questions) that the
// developer marked in the form editor count: "income" — money the firm
// received that isn't a client payment in Ledger, e.g. translation or
// document fees — or "expense" — money spent, e.g. taxi or stamps. Unmarked
// ones aren't counted (they may repeat a payment already recorded on a
// client) but are listed, so nothing is silently left out.
//
// A report keeps a copy of its form as it was (Report.fields), but whether a
// question counts is read from the form as it is NOW (by question id): marking
// a question once also counts the reports sent before.

const KINDS = ["income", "expense"];

// { entries, unclassified } for a list of reports (with `employee` and
// `template`), given the forms as they are now.
function reportMoney(reports, templates) {
  const forms = new Map(
    templates.map((t) => [t.id, { name: t.name, fields: new Map((Array.isArray(t.fields) ? t.fields : []).map((f) => [f.id, f])) }])
  );
  const entries = [];
  const unclassified = new Map();

  function add(kind, entry) {
    if (!(entry.amount > 0)) return;
    if (KINDS.includes(kind)) {
      entries.push({ ...entry, kind });
      return;
    }
    const key = `${entry.templateId}|${entry.fieldId}|${entry.columnId || ""}`;
    const u = unclassified.get(key) || { form: entry.form, label: entry.label, column: entry.column, amount: 0, count: 0, byEmployee: {} };
    u.amount += entry.amount;
    u.count += 1;
    u.byEmployee[entry.employeeId] = (u.byEmployee[entry.employeeId] || 0) + entry.amount;
    unclassified.set(key, u);
  }

  for (const r of reports) {
    const form = forms.get(r.templateId);
    for (const asked of Array.isArray(r.fields) ? r.fields : []) {
      const value = r.answers?.[asked.id];
      if (value === undefined || value === null) continue;
      const now = form?.fields.get(asked.id);
      const field = now && now.type === asked.type ? now : asked;
      const base = {
        reportId: r.id,
        date: r.date,
        employeeId: r.employeeId,
        person: r.employee?.name ?? null,
        templateId: r.templateId,
        form: form?.name ?? r.template?.name ?? null,
        fieldId: asked.id,
        label: field.label,
        columnId: null,
        column: null,
        service: null,
      };
      if (asked.type === "money") {
        add(field.finance, { ...base, amount: Number(value) || 0 });
      } else if (asked.type === "table" && Array.isArray(value)) {
        const columns = Array.isArray(asked.columns) ? asked.columns : [];
        const nowColumns = new Map((Array.isArray(field.columns) ? field.columns : []).map((c) => [c.id, c]));
        // What each row is — its first choice (or text) column, e.g. "Service".
        const by = columns.find((c) => c.type === "select") || columns.find((c) => c.type === "text");
        for (const row of value) {
          const service = by && typeof row?.[by.id] === "string" && row[by.id].trim() ? row[by.id].trim() : null;
          for (const col of columns) {
            if (col.type !== "money") continue;
            const c = nowColumns.get(col.id) || col;
            add(c.finance, { ...base, columnId: col.id, column: c.label, service, amount: Number(row?.[col.id]) || 0 });
          }
        }
      }
    }
  }

  return { entries, unclassified: [...unclassified.values()].sort((a, b) => b.amount - a.amount) };
}

// Entries added up by what they are: question (and column), and the row's
// service when there is one — "Tarjima → Notarial: 1 250 000, 9 times".
function groupEntries(entries) {
  const items = new Map();
  for (const e of entries) {
    const key = [e.templateId, e.fieldId, e.columnId || "", (e.service || "").toLowerCase()].join("|");
    const item = items.get(key) || { form: e.form, label: e.label, column: e.column, service: e.service, amount: 0, count: 0, people: new Set() };
    item.amount += e.amount;
    item.count += 1;
    if (e.person) item.people.add(e.person);
    items.set(key, item);
  }
  return [...items.values()].map((i) => ({ ...i, people: [...i.people] })).sort((a, b) => b.amount - a.amount);
}

module.exports = { reportMoney, groupEntries, KINDS };
