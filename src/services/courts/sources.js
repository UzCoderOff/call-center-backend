const { searchable } = require("../clients");

// The Supreme Court's hearing lists on sud.uz, as pure rules (tested in
// test/courts.test.js). The same lists the court's own page, jadval2.sud.uz,
// shows: one court, one day, every hearing set for it — no login, no
// documentation, so Ledger reads them gently (services/courts/sync.js).
//
//   criminal        api4.sud.uz/{court}/{DDMMYYYY}       case numbers 1-…
//   offence         api5.sud.uz/{court}/{DDMMYYYY}       3-… (maʼmuriy huquqbuzarlik)
//   civil           jadvalapi.sud.uz/vka/CIVIL/{court}/{DDMMYYYY}     2-…
//   economic        jadvalapi.sud.uz/vka/ECONOMIC/{court}/{DDMMYYYY}  4-…
//   administrative  jadvalapi.sud.uz/vka/CONFLICT/{court}/{DDMMYYYY}  5-…
//
// A case keeps its number from the first court to the Supreme Court:
// 2-1001-2607/59591 is a civil case (2) begun in court 1001 (Mirzo Ulugʻbek),
// and the city court's appeal list shows it under the same number. The
// criminal lists also show past days and about a week ahead; the others
// today and weeks ahead (an earlier day is refused).

const TYPES = {
  criminal: { section: "jib/jib", prefix: "1", list: (id, d) => `https://api4.sud.uz/${encodeURIComponent(id)}/${d}` },
  offence: { section: "jib/mhb", prefix: "3", list: (id, d) => `https://api5.sud.uz/${encodeURIComponent(id)}/${d}` },
  civil: { section: "fib", prefix: "2", list: (id, d) => `https://jadvalapi.sud.uz/vka/CIVIL/${encodeURIComponent(id)}/${d}` },
  economic: { section: "is", prefix: "4", list: (id, d) => `https://jadvalapi.sud.uz/vka/ECONOMIC/${encodeURIComponent(id)}/${d}` },
  administrative: { section: "mib", prefix: "5", list: (id, d) => `https://jadvalapi.sud.uz/vka/CONFLICT/${encodeURIComponent(id)}/${d}` },
};
const TYPE_KEYS = Object.keys(TYPES);
const typeOfPrefix = (prefix) => TYPE_KEYS.find((t) => TYPES[t].prefix === prefix) || null;

// How many days ahead each kind of list is worth reading. Three weeks, not
// more: every day further is another list a night, for each court; a hearing
// set later is found once it's three weeks off.
const AHEAD_DAYS = { criminal: 10, offence: 10, civil: 21, economic: 21, administrative: 21 };

// "2026-10-29" -> "29102026", as the lists take it.
const listDay = (iso) => `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}`;
// SUD_LISTS_URL: a stand-in for sud.uz on a test server ({base}/{type}/{court}/{day}).
const listUrl = (court, iso) =>
  process.env.SUD_LISTS_URL ? `${process.env.SUD_LISTS_URL}/${court.type}/${encodeURIComponent(court.id)}/${listDay(iso)}` : TYPES[court.type].list(court.id, listDay(iso));

// A case number as people type it and as the lists write it, made one:
// "№ 2-1001-2607/59591 " -> "2-1001-2607/59591".
function normalizeNumber(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[№#]/g, "")
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, "")
    .trim();
}

// The court a number began in: "2-1001-2607/59591" -> "2-1001". Older
// numbers ("1-111/2016") don't say.
function numberCode(value) {
  const m = normalizeNumber(value).match(/^(\d)-(\d{2,5})-\d{3,4}\/\d+$/);
  return m ? `${m[1]}-${m[2]}` : null;
}

// The kind of case a number is: "2-…" civil, "1-…" criminal.
const numberType = (value) => {
  const m = normalizeNumber(value).match(/^(\d)-/);
  return m ? typeOfPrefix(m[1]) : null;
};

// The court's word for the stage -> Ledger's (services/clients.js LEGAL_STAGES).
function stageOf(instance) {
  const s = String(instance || "").toLowerCase();
  if (/тафтиш|taftish/.test(s)) return /олий|oliy/.test(s) ? "supreme_review" : "review";
  if (/кассация|kassatsiya/.test(s)) return "cassation";
  if (/апелляция|apellyatsiya/.test(s)) return "appeal";
  if (/биринчи|birinchi/.test(s)) return "first_instance";
  return null;
}

const clean = (v, max) => {
  const s = String(v ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s ? s.slice(0, max) : null;
};

// The people in one side of a hearing, without the criminal code's articles:
// "ALIEV SARDOR <BR>(169-modda …);<BR><BR>KARIMOV …" -> ["ALIEV SARDOR", "KARIMOV …"].
function partiesOf(value) {
  const out = [];
  for (const piece of String(value ?? "").split(/<br\s*\/?>|;/i)) {
    let name = piece;
    // Articles inside articles: "(169-модда … (Ўғрилик))", innermost first.
    while (/\([^()]*\)/.test(name)) name = name.replace(/\([^()]*\)/g, "");
    name = name.replace(/[()]/g, "").replace(/\s+/g, " ").trim();
    if (name && !out.includes(name)) out.push(name.slice(0, 200));
  }
  return out;
}

// The articles a criminal case is about: "169-модда 3-қисми а-банди (Ўғрилик)".
function articlesOf(value) {
  const out = [];
  for (const m of String(value ?? "").matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    const a = m[1].replace(/\s+/g, " ").trim();
    if (a && !out.includes(a)) out.push(a);
  }
  return out.join("; ").slice(0, 300) || null;
}

const toMinutes = (hhmm) => {
  const m = String(hhmm ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const t = Number(m[1]) * 60 + Number(m[2]);
  return t >= 0 && t < 24 * 60 ? t : null;
};

const toIso = (ddmmyyyy) => {
  const m = String(ddmmyyyy ?? "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

// One list's rows, the same shape whatever the court:
// { number, date, time, judge, stage, instance, category, parties: { claimant[], defendant[] } }.
// Rows without a number or a day are left out.
function parseList(type, rows) {
  if (!Array.isArray(rows)) return [];
  const criminalShape = type === "criminal" || type === "offence";
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const number = normalizeNumber(r.casenumber);
    const date = toIso(criminalShape ? r.hearingdate : r.hearing_date);
    if (!number || !date) continue;
    out.push({
      number,
      date,
      time: toMinutes(criminalShape ? r.hearingtime : r.hearing_time),
      judge: clean(criminalShape ? r.judge : r.responsible, 120),
      instance: clean(r.instance, 80),
      stage: stageOf(r.instance),
      category: criminalShape ? articlesOf(r.defendant) : clean(r.category, 300),
      parties: { claimant: partiesOf(criminalShape ? r.claimant : r.claiment), defendant: partiesOf(r.defendant) },
    });
  }
  return out;
}

// Names, compared: Cyrillic or Latin, any order, "Abdullayev" = "Абдуллаев",
// "oʻgʻli" = "ўғли". Words a company's name carries whatever it is (MChJ,
// masʼuliyati cheklangan jamiyat…) don't count.
const LEGAL_FORMS = new Set(
  "mchj masuliyati cheklangan jamiyati jamiyat jamiyatining aj aksiyadorlik xk xususiy korxona korxonasi ok oilaviy dk davlat muassasasi muassasa unitar mas llc ooo ao firma firmasi qk qoshma filiali filial tumani shaxar sh"
    .split(" ")
    .map(searchable)
);
function nameWords(value) {
  return searchable(value)
    .replace(/ye/g, "e")
    .split(" ")
    .filter((w) => w.length >= 2);
}

// Whether a party in a list is this client: every word of the client's name
// (at least two — a first name and a surname) is one of the party's words.
// A company: its own name (the words left without MChJ and the like), five
// letters or more when it's one word. Ledger only asks — a person says yes.
function sameName(clientName, partyName) {
  const mine = nameWords(clientName);
  const theirs = new Set(nameWords(partyName));
  if (mine.length === 0 || theirs.size === 0) return false;
  const company = mine.some((w) => LEGAL_FORMS.has(w));
  if (company) {
    const own = mine.filter((w) => !LEGAL_FORMS.has(w));
    if (own.length === 0 || (own.length === 1 && own[0].length < 5)) return false;
    return own.every((w) => theirs.has(w));
  }
  if (mine.length < 2) return false;
  return mine.slice(0, 4).every((w) => theirs.has(w));
}

// Which side of a hearing the client is on, if either.
function sideOf(row, clientName) {
  if (row.parties.claimant.some((p) => sameName(clientName, p))) return "claimant";
  if (row.parties.defendant.some((p) => sameName(clientName, p))) return "defendant";
  return null;
}

module.exports = {
  TYPES,
  TYPE_KEYS,
  AHEAD_DAYS,
  listDay,
  listUrl,
  normalizeNumber,
  numberCode,
  numberType,
  stageOf,
  partiesOf,
  articlesOf,
  parseList,
  nameWords,
  sameName,
  sideOf,
};
