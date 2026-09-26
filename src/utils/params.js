// Query/route parameter parsing. Invalid input becomes a 400 with a clear
// message instead of reaching Prisma as NaN (or throwing inside BigInt())
// and surfacing as a confusing 500.

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function parseId(value, name = "id") {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`invalid ${name}`);
  return n;
}

// Epoch milliseconds, or undefined when the parameter wasn't given.
function parseMs(value, name) {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw badRequest(`invalid ${name}`);
  return n;
}

module.exports = { badRequest, parseId, parseMs };
