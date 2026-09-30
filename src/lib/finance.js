// Who sees the money from clients, and taking it out of what everyone else
// gets.
//
// "Money" here is the firm's contract deals with clients: contract amounts,
// payments towards contracts (and other large ones), and what clients still
// owe. (Staff daily reports are not part of it — they have their own access
// rules.)
//
// The DEVELOPER always sees it. Besides them, only a boss or lawyer account
// whose "Moliya" switch the DEVELOPER turned on (User.seesFinance) — meant
// for the head of the firm. Other lawyers, even on their own cases, and all
// staff never see it, and only people who see it can set contract amounts or
// record contract payments.
//
// The consultation fee (e.g. 450 000 soʻm) is the exception: staff check it
// before booking the client in, so payments of kind "consultation" are
// visible to everyone who sees the client, and staff can record them.
//
// The server leaves money out of its answers; the portal hiding it is only
// the second line.

const FINANCE_ROLES = ["BOSS", "LAWYER"];
const CONSULTATION = "consultation";

const isConsultation = (payment) => payment?.kind === CONSULTATION;

// Payments this person may see: all of them with Moliya, otherwise only the
// consultation fees.
function visiblePayments(user, payments) {
  if (!Array.isArray(payments)) return [];
  return canSeeFinance(user) ? payments : payments.filter(isConsultation);
}

function canSeeFinance(user) {
  if (!user || user.active === false) return false;
  return user.role === "DEVELOPER" || (FINANCE_ROLES.includes(user.role) && user.seesFinance === true);
}

function financeForbidden() {
  const err = new Error("finance_forbidden");
  err.status = 403;
  return err;
}

// An automatic report day (or totals) as someone without Moliya sees it: the
// payments line counts consultation fees only.
function consultationPaymentsOnly(day) {
  if (!day || typeof day !== "object") return day;
  const { payments, consultationPayments, ...rest } = day;
  return { ...rest, payments: consultationPayments || { count: 0, amount: 0 } };
}

// …and with Moliya: all payments (the consultation split isn't needed).
function allPayments(day) {
  if (!day || typeof day !== "object") return day;
  const { consultationPayments, ...rest } = day;
  return rest;
}

// A case without its contract money: no contract amount, paid/remaining, and
// of its payments only the consultation fees.
function caseWithoutMoney(k) {
  if (!k || typeof k !== "object") return k;
  const { contractAmount, payments, paid, remaining, state, installments, schedule, ...rest } = k;
  return Array.isArray(payments) ? { ...rest, payments: payments.filter(isConsultation) } : rest;
}

module.exports = {
  canSeeFinance,
  financeForbidden,
  isConsultation,
  visiblePayments,
  consultationPaymentsOnly,
  allPayments,
  caseWithoutMoney,
  FINANCE_ROLES,
  CONSULTATION,
};
