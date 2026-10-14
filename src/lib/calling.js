const { hasJob, jobWhere } = require("./jobs");

// Whether someone has calls at all — the call-back list, Calls, their
// automatic report, missed-call Telegram, client lists. Two ways in:
//   collectCalls  the Android app syncs their phone's own call log
//   pbxCalling    they call through Ledger's phone line (pbx/README.md)
// collectCalls keeps its narrow meaning (phone sync, sync health); anything
// about "their calls" asks hasCalls.
//
// Only some jobs' calls matter (the firm, 2026-10-14): the call center's and
// the coordinators'. Anyone else's phone isn't monitored — its app stops
// sending its call log, and old ones don't count anywhere.
const CALL_JOBS = ["call_center", "coordinator"];
const callsMatter = (employee) => CALL_JOBS.some((job) => hasJob(employee, job));

// `employee` needs collectCalls, pbxCalling, job and extraJobs.
const hasCalls = (employee) => Boolean((employee?.collectCalls || employee?.pbxCalling) && callsMatter(employee));
// Their phone sends its call log (the app's switch).
const collectsCalls = (employee) => Boolean(employee?.collectCalls && callsMatter(employee));

// The same as a Prisma `where` on Employee.
const hasCallsWhere = () => ({ AND: [{ OR: [{ collectCalls: true }, { pbxCalling: true }] }, jobWhere(CALL_JOBS)] });

// A CallLog `where` for the calls that count: made or taken on the phone of
// someone with one of these jobs (CALL_JOBS by default; an empty list: none).
const countedCallsWhere = (jobs = CALL_JOBS) => ({ employee: jobWhere(jobs.filter((j) => CALL_JOBS.includes(j))) });

module.exports = { CALL_JOBS, callsMatter, hasCalls, collectsCalls, hasCallsWhere, countedCallsWhere };
