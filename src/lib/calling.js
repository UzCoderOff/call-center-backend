// Whether someone has calls at all — the call-back list, Calls, their
// automatic report, missed-call Telegram, client lists. Two ways in:
//   collectCalls  the Android app syncs their phone's own call log
//   pbxCalling    they call through Ledger's phone line (pbx/README.md)
// collectCalls keeps its narrow meaning (phone sync, sync health); anything
// about "their calls" asks hasCalls.
const hasCalls = (employee) => Boolean(employee?.collectCalls || employee?.pbxCalling);

// The same as a Prisma `where` on Employee.
const hasCallsWhere = () => ({ OR: [{ collectCalls: true }, { pbxCalling: true }] });

module.exports = { hasCalls, hasCallsWhere };
