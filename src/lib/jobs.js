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
//
// A person can do more than one: Employee.job is the main one, and
// Employee.extraJobs lists the others ("coordinator,office"). Code asks
// hasJob / isCallCenter / isCoordinator (any of their jobs), and filters the
// database with jobWhere — never `job === …` on its own.
const JOBS = ["call_center", "coordinator", "office", "other"];

// "call_center,coordinator" (a query parameter, or Employee.extraJobs) -> the
// valid jobs in it, in order, without repeats.
function jobList(value) {
  const items = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(items.map((s) => String(s).trim()).filter((s) => JOBS.includes(s)))];
}

const jobOf = (employee) => (JOBS.includes(employee?.job) ? employee.job : "other");

// All of their jobs, the main one first. "other" only when it's all they do.
function jobsOf(employee) {
  const all = jobList([jobOf(employee), ...jobList(employee?.extraJobs)]);
  const real = all.filter((j) => j !== "other");
  return real.length ? real : ["other"];
}

const hasJob = (employee, job) => jobsOf(employee).includes(job);
const isCallCenter = (employee) => hasJob(employee, "call_center");
const isCoordinator = (employee) => hasJob(employee, "coordinator");

// A list of jobs (the first is the main one) -> { job, extraJobs } to store.
function jobFields(jobs) {
  const list = jobList(jobs).filter((j) => j !== "other");
  if (!list.length) return { job: "other", extraJobs: "" };
  return { job: list[0], extraJobs: list.slice(1).join(",") };
}

// Prisma `where` for employees with any of these jobs (main or extra). No job
// name is part of another, so `contains` on the comma list is exact.
function jobWhere(jobs) {
  const list = jobList(jobs);
  return { OR: [{ job: { in: list } }, ...list.map((j) => ({ extraJobs: { contains: j } }))] };
}

// "call_center,coordinator" (a query parameter) -> the valid jobs in it, or
// null when none is given.
function parseJobs(value) {
  if (value === undefined || value === null || value === "") return null;
  const list = jobList(value);
  return list.length ? list : null;
}

module.exports = { JOBS, jobOf, jobsOf, hasJob, isCallCenter, isCoordinator, jobFields, jobWhere, jobList, parseJobs };
