const { hasJob, jobWhere } = require("./jobs");

// Whether someone has calls at all — Calls, their home page, their phone's
// sync. Two ways in:
//   collectCalls  the Android app syncs their phone's own call log
//   pbxCalling    they call through Ledger's phone line (pbx/README.md)
// collectCalls keeps its narrow meaning (phone sync, sync health); anything
// about "their calls" asks hasCalls.
//
// Everyone's calls are seen, but only some jobs' calls are counted (the
// firm, 2026-10-14/15): the call center's and the coordinators'. Office
// workers (and anyone else) see their own calls — their own missed ones to
// call back too — and managers can switch them on in Calls and Home (off by
// default; then the numbers there include them). They don't count toward
// targets, Natijalar, automatic reports, the firm's own totals, strikes or
// the missed-call and recording alerts. Those ask countsCalls (or
// countedCallsWhere).
const CALL_JOBS = ["call_center", "coordinator"];
const callsMatter = (employee) => CALL_JOBS.some((job) => hasJob(employee, job));

// `employee` needs collectCalls and pbxCalling (countsCalls: job and extraJobs too).
const hasCalls = (employee) => Boolean(employee?.collectCalls || employee?.pbxCalling);
// Their phone sends its call log (the app's switch).
const collectsCalls = (employee) => Boolean(employee?.collectCalls);
// Their calls count (targets, reports, alerts, client lists).
const countsCalls = (employee) => hasCalls(employee) && callsMatter(employee);

// countsCalls as a Prisma `where` on Employee.
const hasCallsWhere = () => ({ AND: [{ OR: [{ collectCalls: true }, { pbxCalling: true }] }, jobWhere(CALL_JOBS)] });

// A CallLog `where` for the calls that count: made or taken on the phone of
// someone with one of these jobs (CALL_JOBS by default; an empty list: none).
const countedCallsWhere = (jobs = CALL_JOBS) => ({ employee: jobWhere(jobs.filter((j) => CALL_JOBS.includes(j))) });

module.exports = { CALL_JOBS, callsMatter, hasCalls, collectsCalls, countsCalls, hasCallsWhere, countedCallsWhere };
