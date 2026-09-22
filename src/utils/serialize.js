// Prisma returns BigInt for the millisecond-timestamp columns (SQLite has
// no native 64-bit int type Prisma trusts as a JS number). JSON.stringify
// throws on BigInt, so every value that leaves an API response has to be
// converted first. Millisecond epoch timestamps are always far below
// Number.MAX_SAFE_INTEGER, so this conversion never loses precision.
function serializeCall(call) {
  if (!call) return call;
  return {
    ...call,
    callTimestampMs: call.callTimestampMs != null ? Number(call.callTimestampMs) : null,
    syncedAtMs: call.syncedAtMs != null ? Number(call.syncedAtMs) : null,
  };
}

module.exports = { serializeCall };
