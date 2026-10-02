// What a person does at the firm (Employee.job — see prisma/schema.prisma):
// it decides which tools and numbers apply to them, instead of guessing from
// their other settings.
//
//   call_center  sales calls and booking consultations — their missed calls
//                go on the call-back list (and to Telegram); Calls and Home
//                show them by default
//   coordinator  the clients' cases after the contract, assigned to them
//   office       office work, measured on their daily report form
//   other
const JOBS = ["call_center", "coordinator", "office", "other"];

const jobOf = (employee) => (JOBS.includes(employee?.job) ? employee.job : "other");
const isCallCenter = (employee) => jobOf(employee) === "call_center";
const isCoordinator = (employee) => jobOf(employee) === "coordinator";

// "call_center,coordinator" (a query parameter) -> the valid jobs in it, or
// null when none is given.
function parseJobs(value) {
  if (value === undefined || value === null || value === "") return null;
  const list = String(value)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => JOBS.includes(s));
  return list.length ? [...new Set(list)] : null;
}

module.exports = { JOBS, jobOf, isCallCenter, isCoordinator, parseJobs };
