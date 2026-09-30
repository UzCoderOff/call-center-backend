const { isValidDate } = require("../lib/firmTime");

// A contract's payment schedule (CaseInstallment): what's due when.
//
// Payments towards the contract — every payment on the case except the
// consultation fee (see services/clients.js paymentSummary) — are applied to
// the installments in date order, so each one is:
//   paid       covered in full
//   overdue    its date has passed and it isn't covered (the rest is late)
//   due        due today
//   upcoming   still ahead (maybe partly covered already)
// A schedule is a plan, not a bill: paying early simply covers the next
// ones; paying more than the schedule shows as ahead.

const MAX_ITEMS = 60;

function scheduleOf(installments, payments, today) {
  let pool = (payments || []).filter((p) => p.kind !== "consultation").reduce((s, p) => s + (p.amount || 0), 0);
  const items = [...(installments || [])]
    .sort((a, b) => (a.dueDate === b.dueDate ? a.id - b.id : a.dueDate < b.dueDate ? -1 : 1))
    .map((i) => {
      const paid = Math.min(pool, i.amount);
      pool -= paid;
      const left = i.amount - paid;
      const status = left === 0 ? "paid" : i.dueDate < today ? "overdue" : i.dueDate === today ? "due" : "upcoming";
      return { id: i.id, dueDate: i.dueDate, amount: i.amount, note: i.note ?? null, paid, left, status };
    });
  const overdue = items.filter((i) => i.status === "overdue");
  const next = items.find((i) => i.status === "due" || i.status === "upcoming") || null;
  return {
    items,
    scheduled: items.reduce((s, i) => s + i.amount, 0),
    overdue: overdue.reduce((s, i) => s + i.left, 0),
    overdueSince: overdue[0]?.dueDate ?? null,
    next: next ? { dueDate: next.dueDate, left: next.left } : null,
    // Paid beyond everything scheduled so far.
    ahead: pool,
  };
}

// Checks a schedule sent from the portal: [{ dueDate, amount, note? }].
function normalizeSchedule(input) {
  if (!Array.isArray(input)) throw Object.assign(new Error("items must be a list"), { status: 400 });
  if (input.length > MAX_ITEMS) throw Object.assign(new Error(`at most ${MAX_ITEMS} payments`), { status: 400 });
  return input.map((raw, i) => {
    const amount = Number(String(raw?.amount ?? "").replace(/[\s ]/g, ""));
    if (!isValidDate(raw?.dueDate)) throw Object.assign(new Error(`payment ${i + 1}: invalid date`), { status: 400 });
    if (!Number.isInteger(amount) || amount <= 0 || amount > 100_000_000_000) throw Object.assign(new Error(`payment ${i + 1}: invalid amount`), { status: 400 });
    const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim().slice(0, 200) : null;
    return { dueDate: raw.dueDate, amount, note };
  });
}

module.exports = { scheduleOf, normalizeSchedule, MAX_ITEMS };
