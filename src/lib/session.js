const { signSessionToken } = require("./tokens");
const env = require("../config/env");

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
// collectCalls, Reports only with a report form.
function publicMe(user) {
  const e = user.employee;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    employee: e
      ? {
          id: e.id,
          name: e.name,
          collectCalls: e.collectCalls,
          hasReport: e.reportTemplateId != null,
          calendarAccess: e.calendarAccess,
        }
      : null,
  };
}

module.exports = { COOKIE_OPTIONS, startSession, endSession, publicMe };
