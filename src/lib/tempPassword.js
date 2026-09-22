const crypto = require("crypto");

// 12 random base64url chars — readable enough to read over the phone, long
// enough to be a fine one-time credential. Shared by every place that mints
// a system-generated temporary password (new employee, new boss account,
// password reset).
function generateTempPassword() {
  return crypto.randomBytes(9).toString("base64url");
}

module.exports = { generateTempPassword };
