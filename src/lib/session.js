const { signSessionToken } = require("./tokens");
const env = require("../config/env");
const { canSeeFinance } = require("./finance");
const { asksForm } = require("../services/autoReport");
const { jobsOf } = require("./jobs");
const { hasCalls, countsCalls } = require("./calling");

// The portal login cookie. Shared by the web login (routes/auth.js) and the
// Android app, which gets a session cookie for its in-app portal view from
// its device token (routes/device.js).
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: env.cookieSecure,
  sameSite: env.cookieSameSite,
  maxAge: 12 * 60 * 60 * 1000, // 12h; independent of JWT_EXPIRES_IN, just a cookie lifetime ceiling
};

function startSession(res, user) {
  res.cookie("session", signSessionToken(user), COOKIE_OPTIONS);
}

function endSession(res) {
  const { maxAge, ...clearOptions } = COOKIE_OPTIONS;
  res.clearCookie("session", clearOptions);
}

// What the portal (and the app) knows about whoever is signed in. The
// employee part drives which sections they see: Calls only with
// collectCalls, Reports only with a report form or an automatic report.
function publicMe(user) {
  const e = user.employee;
  return {
    id: user.id,
    username: user.username,
    name: user.name ?? null,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    // Sees the money from clients (contract amounts, payments, debts).
    finance: canSeeFinance(user),
    // Sees the calls going on right now and may listen (services/pbx/live.js).
    hearsCalls: require("../services/pbx/live").canHearCalls(user),
    employee: e
      ? {
          id: e.id,
          name: e.name,
          collectCalls: e.collectCalls,
          // Calls at all: synced from their phone, or through Ledger's line.
          hasCalls: hasCalls(e),
          // ...and they count (call center, coordinators): client lists.
          countsCalls: countsCalls(e),
          // Ledger's phone line: whether it's on for them, and their phone ID.
          pbxCalling: e.pbxCalling,
          ext: e.pbx?.ext ?? null,
          hasReport: e.reportTemplateId != null || e.autoReport,
          autoReport: e.autoReport,
          alsoForm: e.alsoForm,
          // A report form to fill in today (alone, or next to the automatic report).
          reportForm: asksForm(e),
          calendarAccess: e.calendarAccess,
          // What they do (call center, coordinator, office…): their home
          // page and tools follow it.
          job: e.job,
          // All of their jobs (main first) when they do more than one.
          jobs: jobsOf(e),
        }
      : null,
  };
}

module.exports = { COOKIE_OPTIONS, startSession, endSession, publicMe };
