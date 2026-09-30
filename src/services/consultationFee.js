const cl = require("./clients");
const { badRequest } = require("../utils/params");
const { firmNow } = require("../lib/firmTime");
const { CONSULTATION } = require("../lib/finance");

// The consultation fee — taken when the client is booked in ("fee received"
// in the booking form) or later, at the appointment. It's a payment of kind
// "consultation" on the client's case, linked to the appointment, and
// visible to everyone who works with the client (src/lib/finance.js).

// The usual fee, filled in by the portal; CONSULTATION_FEE in .env changes it.
const DEFAULT_FEE = Number(process.env.CONSULTATION_FEE) || 450000;
const METHODS = ["cash", "card", "transfer"];

// { amount, method } from a request; the amount defaults to the usual fee.
function normalizeFee(b = {}) {
  const amount = b.feeAmount === undefined || b.feeAmount === null || b.feeAmount === "" ? DEFAULT_FEE : cl.amount(b.feeAmount, "feeAmount");
  if (!amount) throw badRequest("invalid feeAmount");
  const method = b.feeMethod === undefined || b.feeMethod === null || b.feeMethod === "" ? "cash" : b.feeMethod;
  if (!METHODS.includes(method)) throw badRequest("invalid feeMethod");
  return { amount, method };
}

// Records the fee for `appointment` (which must belong to `clientId`) on the
// client's current open case — the one the booking made or found.
async function recordFee(tx, { appointment, clientId, user, amount, method }) {
  const openCase = await tx.clientCase.findFirst({
    where: { clientId, status: { in: cl.OPEN_STATUSES } },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  const payment = await tx.payment.create({
    data: {
      clientId,
      caseId: openCase?.id ?? null,
      appointmentId: appointment.id,
      amount,
      method,
      kind: CONSULTATION,
      date: firmNow().date,
      recordedById: user.id,
    },
    select: { id: true, amount: true, method: true, date: true },
  });
  await tx.client.update({ where: { id: clientId }, data: { updatedAt: new Date() } });
  return payment;
}

// A fee recorded on the client's page ("Toʻlov qoʻshish", kind
// consultation) isn't tied to an appointment, so the calendar would say "not
// paid". This pairs a client's untied consultation fees — and ones tied to a
// cancelled appointment — with their appointments that have no fee yet: each
// fee to the appointment nearest its date, within LINK_WINDOW_DAYS. Called
// after booking, recording a fee, or cancelling; safe to run any time.
const LINK_WINDOW_DAYS = 60;
const dayNumber = (date) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86400000;

function pairFees(payments, appointments) {
  const free = payments.filter((p) => !p.appointmentId || p.appointmentStatus === "cancelled");
  const unpaid = appointments.filter((a) => a.status !== "cancelled" && !a.paid);
  const pairs = [];
  for (const p of free) {
    let best = null;
    for (const a of unpaid) {
      const gap = Math.abs(dayNumber(a.date) - dayNumber(p.date));
      if (gap <= LINK_WINDOW_DAYS && (!best || gap < best.gap)) best = { a, gap };
    }
    if (!best) continue;
    pairs.push({ paymentId: p.id, appointmentId: best.a.id });
    unpaid.splice(unpaid.indexOf(best.a), 1);
  }
  return pairs;
}

async function linkConsultationFees(db, clientId) {
  if (!clientId) return 0;
  const [payments, appointments] = await Promise.all([
    db.payment.findMany({
      where: { clientId, kind: CONSULTATION },
      orderBy: [{ date: "asc" }, { id: "asc" }],
      select: { id: true, date: true, appointmentId: true, appointment: { select: { status: true } } },
    }),
    db.appointment.findMany({
      where: { clientId },
      orderBy: [{ date: "asc" }, { start: "asc" }],
      select: { id: true, date: true, status: true, payments: { where: { kind: CONSULTATION }, select: { id: true } } },
    }),
  ]);
  const pairs = pairFees(
    payments.map((p) => ({ id: p.id, date: p.date, appointmentId: p.appointmentId, appointmentStatus: p.appointment?.status })),
    appointments.map((a) => ({ id: a.id, date: a.date, status: a.status, paid: a.payments.length > 0 }))
  );
  for (const pair of pairs) await db.payment.update({ where: { id: pair.paymentId }, data: { appointmentId: pair.appointmentId } });
  return pairs.length;
}

// Once at startup: the fees recorded before this existed.
async function linkAllConsultationFees(db) {
  const rows = await db.payment.findMany({
    where: { kind: CONSULTATION, OR: [{ appointmentId: null }, { appointment: { status: "cancelled" } }], client: { appointments: { some: {} } } },
    select: { clientId: true },
    distinct: ["clientId"],
  });
  let linked = 0;
  for (const row of rows) linked += await linkConsultationFees(db, row.clientId);
  return linked;
}

module.exports = { DEFAULT_FEE, METHODS, normalizeFee, recordFee, pairFees, linkConsultationFees, linkAllConsultationFees, LINK_WINDOW_DAYS };
