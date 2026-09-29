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

module.exports = { DEFAULT_FEE, METHODS, normalizeFee, recordFee };
