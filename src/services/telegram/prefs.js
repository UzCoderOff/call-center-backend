const { MANAGER_ROLES } = require("../../middleware/auth");

// The kinds of Telegram notification, and who each one is for. Each person
// sees (in the portal and in the bot's Sozlamalar) only the kinds that apply
// to them, all on until they switch one off.
//
// The portal has its own translated labels for these keys (i18n
// "telegram.kinds.*"); these are the bot's.
const KINDS = [
  { key: "appointments", label: "Uchrashuvlar", hint: "yangi yozilish va bekor qilinganlar" },
  { key: "missedCalls", label: "Javobsiz qoʻngʻiroqlar", hint: "qayta qoʻngʻiroq qilinmagan boʻlsa" },
  { key: "digest", label: "Ertalabki xulosa", hint: "har kuni 8:30 da kun rejasi" },
  { key: "reportReminder", label: "Hisobot eslatmasi", hint: "17:30 da, topshirilmagan boʻlsa" },
  { key: "materials", label: "Yangi materiallar", hint: "siz uchun qoʻshilgan oʻquv materiallari" },
  { key: "planning", label: "Jadval eslatmasi", hint: "keyingi hafta tasdiqlanmagan boʻlsa" },
  { key: "tasks", label: "Vazifalar", hint: "yangi vazifa, muddatdan oldin eslatma" },
];
const KEYS = KINDS.map((k) => k.key);

const isManagerUser = (user) => MANAGER_ROLES.includes(user.role);
const ownsCalendar = (user) => Boolean(user.calendar?.active);
const booksAppointments = (user) => isManagerUser(user) || user.employee?.calendarAccess === "book";

// Which kinds apply to this person. `user` needs `employee` and `calendar`.
function applicableKinds(user) {
  const e = user.employee;
  const out = [];
  if (ownsCalendar(user) || booksAppointments(user)) out.push("appointments");
  if (e?.collectCalls) out.push("missedCalls");
  out.push("digest");
  if (e && e.reportTemplateId != null && (!e.autoReport || e.alsoForm)) out.push("reportReminder");
  if (!isManagerUser(user)) out.push("materials");
  if (ownsCalendar(user)) out.push("planning");
  // Anyone can be given a task; managers also hear when theirs are done.
  out.push("tasks");
  return out;
}

// { key: on/off } for the kinds that apply; missing means on.
function effectivePrefs(user, stored) {
  const saved = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  return Object.fromEntries(applicableKinds(user).map((key) => [key, saved[key] !== false]));
}

function wants(user, kind) {
  return Boolean(effectivePrefs(user, user.telegram?.prefs)[kind]);
}

module.exports = { KINDS, KEYS, applicableKinds, effectivePrefs, wants, ownsCalendar, booksAppointments, isManagerUser };
