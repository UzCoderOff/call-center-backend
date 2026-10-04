const prisma = require("../../lib/prisma");
const { phoneKey } = require("../../lib/phone");
const { clientIndex } = require("../../lib/clientsDb");

// Asterisk asks (hooks.js, [company-line]) who is calling: the name of the
// Ledger client with that number, shown on the operator's phone while it
// rings — "" when Ledger doesn't know the number. Only the name travels with
// the call (to our own phones, encrypted); the rest the operator sees in
// Ledger.
async function caller({ num }) {
  const key = phoneKey(num);
  if (!key) return "";
  const client = (await clientIndex(prisma, [key])).get(key);
  return client ? callerLabel(client.name) : "";
}

// Safe as a SIP display name and inside the dialplan: no quotes, separators,
// variable markers or control characters; short.
function callerLabel(name) {
  return String(name ?? "")
    .replace(/["'<>;,:?|\[\](){}$\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim();
}

module.exports = { caller, callerLabel };
