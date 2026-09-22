const jwt = require("jsonwebtoken");
const env = require("../config/env");

// Payload is intentionally minimal — just enough to authorize requests.
// Anything that can change (name, active status) is looked up fresh from
// the DB by the auth middleware rather than trusted from the token, so a
// revoked/deactivated account stops working immediately rather than at
// next token expiry.
function signSessionToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  });
}

function verifySessionToken(token) {
  return jwt.verify(token, env.jwtSecret);
}

module.exports = { signSessionToken, verifySessionToken };
