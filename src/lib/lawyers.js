const prisma = require("./prisma");
const cl = require("../services/clients");

// The firm's lawyers are portal accounts: BOSS (sees everything — and may
// take cases too) or LAWYER (sees only their own calendar and the cases
// assigned to them). A case points at one (ClientCase.lawyerId) and keeps
// their name in ClientCase.lawyer for lists and exports.

const LAWYER_ROLES = ["BOSS", "LAWYER"];
const SELECT = { id: true, username: true, name: true, role: true, active: true, calendar: { select: { name: true } } };

// Their name on cases: the account's name, else its calendar's, else the
// username.
const displayName = (user) => user.name || user.calendar?.name || user.username;

// Everyone a case can be assigned to (active accounts), by name.
async function lawyerAccounts(db = prisma) {
  const users = await db.user.findMany({ where: { role: { in: LAWYER_ROLES }, active: true }, select: SELECT });
  return users.map((u) => ({ id: u.id, name: displayName(u), role: u.role })).sort((a, b) => a.name.localeCompare(b.name));
}

// One assignable lawyer by id, or null.
async function lawyerById(id, db = prisma) {
  const user = await db.user.findUnique({ where: { id }, select: SELECT });
  if (!user || !user.active || !LAWYER_ROLES.includes(user.role)) return null;
  return { id: user.id, name: displayName(user), role: user.role };
}

// The words that identify a person in a name: "Advokat Karimov A." ->
// ["karimov"]. Initials and titles don't count.
const TITLES = new Set(["advokat", "yurist", "adv"].map((w) => cl.searchable(w)));
const nameWords = (text) =>
  cl
    .searchable(text)
    .split(" ")
    .filter((w) => w.length >= 3 && !TITLES.has(w));

// A lawyer written in a spreadsheet ("Karimov A.", "Каримов Акмал") ->
// the one account it names: every identifying word of one name appears in
// the other. None or more than one: no link (the name is still kept).
function matchLawyer(text, accounts) {
  const words = nameWords(text);
  if (words.length === 0) return null;
  const hits = accounts.filter((a) => {
    const theirs = nameWords(a.name);
    if (theirs.length === 0) return false;
    return words.every((w) => theirs.includes(w)) || theirs.every((w) => words.includes(w));
  });
  return hits.length === 1 ? hits[0] : null;
}

module.exports = { LAWYER_ROLES, displayName, lawyerAccounts, lawyerById, matchLawyer };
