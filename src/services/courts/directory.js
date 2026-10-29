const { searchable } = require("../clients");
const { TYPES } = require("./sources");

// Uzbekistan's courts as sud.uz lists them (directory.json, built by
// scripts/court-directory.js): every court's id on the hearing lists, its
// name, region and level — district, regional, the Supreme Court. The code
// its case numbers carry (2-1001-… : Mirzo Ulugʻbek civil) is learned from
// the lists the server reads (services/courts/sync.js, setLearned).
//
// A case climbs within its kind: a district court, the region's court
// (appeal, cassation), the Supreme Court. Those are the lists Ledger reads
// for a case it follows (chain).

const data = require("./directory.json");

// Uzbek Cyrillic -> Latin as people write it ("Мирзо Улуғбек туманлараро
// суди" -> "Mirzo Ulugʻbek tumanlararo sudi"): the portal and the messages
// show the Latin name.
const LATIN = {
  а: "a", б: "b", в: "v", г: "g", ғ: "gʻ", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "y",
  к: "k", қ: "q", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ў: "oʻ",
  ф: "f", х: "x", ҳ: "h", ц: "s", ч: "ch", ш: "sh", щ: "sh", ъ: "ʼ", ы: "i", ь: "", э: "e", ю: "yu",
  я: "ya",
};
const VOWELS = new Set("аеёиоуўэюяaeiou");

function latin(text) {
  let out = "";
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    const lower = ch.toLowerCase();
    let to = LATIN[lower];
    if (to === undefined) {
      out += ch;
      continue;
    }
    // Е at a word's start or after a vowel is "ye" ("Ергаш" -> "Yergash").
    if (lower === "е") {
      const prev = s[i - 1]?.toLowerCase();
      if (!prev || !/[а-яёғқўҳa-z]/.test(prev) || VOWELS.has(prev)) to = "ye";
    }
    out += ch !== lower && to ? to[0].toUpperCase() + to.slice(1) : to;
  }
  return out;
}

const TYPE_WORDS = { criminal: "jinoyat", offence: "maʼmuriy huquqbuzarlik", civil: "fuqarolik", economic: "iqtisodiy", administrative: "maʼmuriy" };

const COURTS = data.courts.map((c) => ({ ...c, nameLatin: latin(c.name) }));
const BY_KEY = new Map(COURTS.map((c) => [c.key, c]));
const BY_CODE = new Map(COURTS.filter((c) => c.code).map((c) => [c.code, c]));
let learned = new Map(); // code -> court

const all = () => COURTS;
const byKey = (key) => (key ? BY_KEY.get(key) || null : null);
const byCode = (code) => (code ? BY_CODE.get(code) || learned.get(code) || null : null);
// The codes learned so far: Map(code -> court key).
const setLearned = (codes) => {
  learned = new Map([...codes].map(([code, key]) => [code, BY_KEY.get(key)]).filter(([, c]) => c));
};

// "Mirzo Ulugʻbek tumanlararo sudi (fuqarolik)"; the Supreme Court:
// "Oliy sud (fuqarolik)".
const label = (court) => (court ? `${court.nameLatin} (${TYPE_WORDS[court.type]})` : null);

const regionCourt = (court) => (court?.region ? COURTS.find((c) => c.type === court.type && c.region === court.region && c.level === "region") || null : null);
const supreme = (type) => COURTS.find((c) => c.type === type && c.level === "supreme") || null;

// The courts a case started in `court` can be heard in: that one, its
// region's court, the Supreme Court.
function chain(court) {
  if (!court) return [];
  const out = [court, regionCourt(court), supreme(court.type)].filter(Boolean);
  return out.filter((c, i) => out.findIndex((x) => x.key === c.key) === i);
}

// Every court in a region that holds hearings of these kinds.
const inRegion = (region, types = Object.keys(TYPES)) => COURTS.filter((c) => c.region === region && types.includes(c.type));

// Which region a place is: a city or district as typed on the client
// ("Toshkent", "Chirchiq", "Yunusobod tumani", "Samarqand viloyati") or a
// court's name. null when it doesn't say.
const REGION_WORDS = [
  ["toshkentvil", ["toshkent viloyati", "toshkent vil", "tashkent region", "toshkent oblast"]],
  ["qoraqalpoq", ["qoraqalpogiston", "karakalpak", "nukus"]],
  ["toshkent", ["toshkent", "tashkent", "taskent"]],
  ["andijon", ["andijon", "andijan"]],
  ["buxoro", ["buxoro", "bukhara", "buxara"]],
  ["fargona", ["fargona", "fergana", "kokand", "qoqon", "margilon"]],
  ["jizzax", ["jizzax", "jizzakh", "jizzak"]],
  ["namangan", ["namangan"]],
  ["navoiy", ["navoiy", "navoi"]],
  ["qashqadaryo", ["qashqadaryo", "kashkadarya", "qarshi", "karshi", "shaxrisabz"]],
  ["samarqand", ["samarqand", "samarkand"]],
  ["sirdaryo", ["sirdaryo", "syrdarya", "guliston"]],
  ["surxondaryo", ["surxondaryo", "surkhandarya", "termiz", "termez"]],
  ["xorazm", ["xorazm", "khorezm", "urganch", "urgench", "xiva", "khiva"]],
].map(([region, words]) => [region, words.map(searchable)]);
// Court names without the words every court has: "Chilonzor", "Angren".
const PLACE_STOP = new Set(["tuman", "tumani", "tumanlararo", "shaxar", "shaxri", "viloyat", "viloyati", "sudi", "sud", "respublikasi", "oliy", "ii"].map(searchable));
const PLACES = COURTS.filter((c) => c.region && c.level === "district").flatMap((c) =>
  searchable(c.nameLatin)
    .split(" ")
    .filter((w) => w.length >= 4 && !PLACE_STOP.has(w))
    .map((w) => [w, c.region])
);

function regionOf(text) {
  const s = ` ${searchable(text)} `;
  if (!s.trim()) return null;
  for (const [region, words] of REGION_WORDS) if (words.some((w) => s.includes(` ${w} `) || s.includes(` ${w}`))) return region;
  for (const [word, region] of PLACES) if (s.includes(` ${word}`)) return region;
  return null;
}

// The list for the portal's court picker.
const publicCourt = (c) => ({ key: c.key, type: c.type, name: c.nameLatin, region: c.region, level: c.level });

module.exports = { all, byKey, byCode, setLearned, label, latin, chain, regionCourt, supreme, inRegion, regionOf, publicCourt, TYPE_WORDS };
