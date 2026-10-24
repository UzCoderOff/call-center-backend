const { MANAGER_ROLES } = require("../../middleware/auth");
const { isCallCenter, isCoordinator } = require("../../lib/jobs");
const { hasCalls, collectsCalls, callsMatter, countsCalls } = require("../../lib/calling");

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
  { key: "targets", label: "Oylik reja", hint: "rahbar sizga reja qoʻyganda" },
  { key: "recordings", label: "Qoʻngʻiroq yozuvlari", hint: "telefon qoʻngʻiroqlarni yozib olmayotgan boʻlsa" },
  { key: "cases", label: "Ishlar", hint: "shartnoma tuzilganda, sizga ish biriktirilganda" },
  { key: "hearings", label: "Sud va tergov sanalari", hint: "bir kun oldin kechqurun, oʻsha kuni ertalab va natija yozilmaganda" },
  { key: "followUps", label: "Eslatmalar", hint: "mijozga qoʻngʻiroq yoki qaror muddati kelganda" },
  { key: "strikes", label: "Ogohlantirishlar", hint: "javobsiz qoʻngʻiroqqa oʻz vaqtida qayta qoʻngʻiroq qilinmaganda" },
  { key: "callReviews", label: "Qoʻngʻiroq tahlili (Beta)", hint: "qoʻngʻiroqingiz matnga aylantirilib, AI baholaganda" },
  { key: "summaries", label: "Suhbat yakunlari", hint: "konsultatsiyadan keyin yakun yozilmagan boʻlsa" },
  { key: "aiReports", label: "AI hisobotlari", hint: "dushanba kungi haftalik hisobot va oylik tahlil" },
  { key: "chat", label: "Chat", hint: "yangi xabarlar — Ledger ilovasi boʻlmasa" },
  { key: "calendar", label: "Shaxsiy kalendar", hint: "kimdir kalendaringizga yozuv qoʻshganda" },
  { key: "news", label: "Yangiliklar", hint: "Ledger yangilanganda — sizga tegishli oʻzgarishlar" },
  { key: "deploys", label: "Server yangilanishi", hint: "yangi versiya oʻrnatildimi yoki xato boʻldimi" },
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
  // The call-back list is the call center's (Employee.job).
  if (hasCalls(e) && isCallCenter(e)) out.push("missedCalls");
  out.push("digest");
  if (e && e.reportTemplateId != null && (!e.autoReport || e.alsoForm)) out.push("reportReminder");
  if (!isManagerUser(user)) out.push("materials");
  if (ownsCalendar(user)) out.push("planning");
  // Consultation summaries to write: whoever holds consultations.
  if (ownsCalendar(user)) out.push("summaries");
  // Anyone can be given a task; managers also hear when theirs are done.
  out.push("tasks");
  // Staff: their monthly plan (Natijalar), when a manager sets it.
  if (e) out.push("targets");
  // A phone that isn't recording calls: its owner (when their calls count),
  // and the managers.
  if ((collectsCalls(e) && callsMatter(e)) || isManagerUser(user)) out.push("recordings");
  // Contracts to hand over (managers), cases handed to them (lawyers,
  // coordinators).
  if (isManagerUser(user) || user.role === "LAWYER" || isCoordinator(e)) out.push("cases");
  // Hearings and other dates in their cases (services/outcomes.js): lawyer
  // accounts (the boss too) and coordinators.
  if (user.role === "LAWYER" || user.role === "BOSS" || isCoordinator(e)) out.push("hearings");
  // Follow-ups due: everyone who works with clients.
  if (isManagerUser(user) || user.role === "LAWYER" || countsCalls(e) || e?.calendarAccess === "book" || isCoordinator(e)) out.push("followUps");
  // Late call-back strikes: the call center, and the managers (over the limit).
  if (isManagerUser(user) || isCallCenter(e)) out.push("strikes");
  // Their calls reviewed by the AI (services/callReview.js): the call center.
  if (isCallCenter(e)) out.push("callReviews");
  // Ledger AI's weekly report and monthly analysis: the managers.
  if (isManagerUser(user)) out.push("aiReports");
  // Chat messages (services/chat.js): here only for people without the app.
  out.push("chat");
  // Their own calendar (routes/personalCalendar.js): lawyer accounts.
  if (user.role === "LAWYER" || user.role === "BOSS") out.push("calendar");
  // What's new in Ledger (services/news.js): everyone.
  out.push("news");
  // Each release on the server, and whether it worked: the developer.
  if (user.role === "DEVELOPER") out.push("deploys");
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
