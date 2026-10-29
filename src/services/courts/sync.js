const { Prisma } = require("@prisma/client");
const prisma = require("../../lib/prisma");
const { firmNow, shiftDate, isoWeekday } = require("../../lib/firmTime");
const { getSetting, setSetting } = require("../../lib/settings");
const { caseRole, EXTRA_LAWYERS } = require("../../lib/clientAccess");
const cl = require("../clients");
const history = require("../caseHistory");
const src = require("./sources");
const dir = require("./directory");

// Court hearings from sud.uz, by themselves (2026-10-29 — "we need to make it
// automatic"). Every night Ledger reads the hearing lists of the courts its
// signed cases are in (services/courts/sources.js) and:
//
//   a case with a number   finds it in its court, the region's court and the
//                          Supreme Court (the number stays the same all the
//                          way up): a new hearing goes into the case's dates,
//                          a moved one or a new time is changed there, one
//                          gone from its day's list is pointed out; reaching
//                          appeal, cassation… moves the case's stage on
//   a case without one     looks for the client's name in the courts of their
//                          region and asks the case's people once: "is this
//                          our client?" (CourtFind). Yes — the case takes the
//                          number and court and is followed from then on; no
//                          — never asked again, and what the list said about
//                          the people is wiped
//
// Its people (its lawyers and coordinator, else the boss) hear about each
// change in the bell, the app and Telegram (kind "hearings"). Only what
// matches the firm's own cases is kept; the lists themselves aren't.
//
// The lists are the court's own site's, with no promise to outsiders, so
// they're read politely: one at a time from the whole server, PAUSE_MS
// apart, each at most once a run — the whole run at 03:00, numbers only
// again at 13:00, and one case at once when its number or court is set, a
// find is answered, or someone presses "check now". When sud.uz stops
// answering it's left alone for a while (makeReader): on 2026-10-29 it
// stopped answering a PC that had read a few hundred lists close together.
// SUD_SYNC=off stops the nightly runs (a test server).

const STATUS_KEY = "courtSync";
const PAUSE_MS = process.env.SUD_PAUSE_MS != null ? Number(process.env.SUD_PAUSE_MS) : 1500;
// This many lists in a row not answered (or refused: 403, 429, 503) and
// sud.uz is left alone for COOL_MS.
const STOP_AFTER = 5;
const COOL_MS = 3 * 60 * 60 * 1000;
// Looking for names: the courts of these kinds, these many days ahead.
const NAME_DAYS = { criminal: 7, civil: 10, economic: 10, administrative: 10 };
// A case checked at once: the courts above its first one, this far ahead.
const HIGHER_DAYS = 14;
const ON_DEMAND_NAME_DAYS = 6;
const MAX_LISTS = 1000;
const MAX_OPEN_ASKS = 3;
// Before court there's nothing to find.
const PRE_COURT = ["inquiry", "investigation"];
// A client whose region isn't known: the firm's own.
const DEFAULT_REGION = process.env.SUD_REGION || "toshkent";

const STAGE_INDEX = new Map(cl.LEGAL_STAGES.map((s, i) => [s, i]));
const STAGE_WORDS = require("../pbx/callerCard").STAGE;
const TITLES = { first_instance: "Birinchi instansiya", appeal: "Apellyatsiya instansiyasi", cassation: "Kassatsiya instansiyasi", review: "Taftish", supreme_review: "Oliy sudda taftish" };

function enabled() {
  return !["off", "0", "false", "no"].includes(String(process.env.SUD_SYNC ?? "").toLowerCase());
}

// Today and the days ahead, Sundays left out.
function daysAhead(today, n) {
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    const d = shiftDate(today, i);
    if (isoWeekday(d) !== 7) out.push(d);
  }
  return out;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

// Every request to sud.uz, from every run and check at once, takes its turn
// here: one at a time, `pauseMs` after the one before. `fails` counts the
// ones in a row sud.uz didn't answer; `coolUntil` is when it's tried again.
const gate = {
  queue: Promise.resolve(),
  last: 0,
  fails: 0,
  coolUntil: 0,
  reset() {
    Object.assign(gate, { queue: Promise.resolve(), last: 0, fails: 0, coolUntil: 0 });
  },
};
function inTurn(fn, pauseMs) {
  const turn = gate.queue.then(async () => {
    const wait = gate.last + pauseMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await fn();
    } finally {
      gate.last = Date.now();
    }
  });
  gate.queue = turn.catch(() => {});
  return turn;
}
// Not answered, or refused as if we were too many: a block, or sud.uz down.
// A plain 400 or 404 is sud.uz answering (one court's list gone, say).
const refused = (err) => !err?.status || [403, 429, 503].includes(err.status);

// Reads lists in turn, each once per run. A list that couldn't be read is
// null — nothing about that day is concluded. STOP_AFTER refusals in a row
// and nothing more is asked of sud.uz for COOL_MS (stats.paused): the rest
// of the run's lists are null too. Each list read also counts the codes of
// its court's first-instance cases (codes: court key -> { day, code -> n }).
function makeReader({ get = fetchJson, pauseMs = PAUSE_MS } = {}) {
  const lists = new Map();
  const stats = { read: 0, failed: 0, paused: false };
  const codes = new Map();
  async function read(court, day) {
    const url = src.listUrl(court, day);
    if (lists.has(url)) return lists.get(url);
    let rows = null;
    if (gate.coolUntil > Date.now()) {
      stats.paused = true;
    } else {
      try {
        rows = src.parseList(court.type, await inTurn(() => get(url), pauseMs));
        stats.read += 1;
        gate.fails = 0;
        countCodes(codes, court, day, rows);
      } catch (err) {
        stats.failed += 1;
        gate.fails = refused(err) ? gate.fails + 1 : 0;
        if (gate.fails >= STOP_AFTER) {
          gate.fails = 0;
          gate.coolUntil = Date.now() + COOL_MS;
          stats.paused = true;
          console.warn(`[courts] sud.uz didn't answer ${STOP_AFTER} lists in a row; left alone until ${new Date(gate.coolUntil).toISOString()}`);
        }
      }
    }
    lists.set(url, rows);
    return rows;
  }
  const rowsOf = (court, day) => lists.get(src.listUrl(court, day)) ?? null;
  return { read, rowsOf, stats, codes };
}

// ------------------------------------------------------------ court codes
// Which court a number's code is (2-1001-… : Mirzo Ulugʻbek civil), learned
// from the lists read anyway: a court's own first-instance cases mostly
// carry its code (a few come in from other courts). Kept as counts per court
// and the days they were counted on, so a list read again isn't counted
// twice (Setting "courtCodes": courts and codes only, nobody's cases).
const CODES_KEY = "courtCodes";
const CODE_MIN_CASES = 3;
const CODE_SHARE = 0.6;
const CODE_DAYS_KEPT = 60;

function countCodes(codes, court, day, rows) {
  const listKey = `${court.key}|${day}`;
  for (const row of rows) {
    if (row.stage !== "first_instance") continue;
    const code = src.numberCode(row.number);
    if (!code) continue;
    const c = codes.get(listKey) || { key: court.key, day, votes: {} };
    c.votes[code] = (c.votes[code] || 0) + 1;
    codes.set(listKey, c);
  }
}

// { court key: { days: [...], votes: { code: n } } } -> Map(code -> court
// key): a code that's most of a court's cases, seen a few times, and no
// other court's.
function claimCodes(stored) {
  const claimed = new Map();
  for (const [key, { votes }] of Object.entries(stored || {})) {
    const counts = Object.entries(votes || {});
    const total = counts.reduce((a, [, n]) => a + n, 0);
    const [code, count] = counts.sort((a, b) => b[1] - a[1])[0] || [];
    if (!code || count < CODE_MIN_CASES || count / total < CODE_SHARE) continue;
    claimed.set(code, claimed.has(code) ? null : key);
  }
  return new Map([...claimed].filter(([, key]) => key));
}

let codesLoaded = false;
async function loadCodes() {
  if (codesLoaded) return;
  dir.setLearned(claimCodes(await getSetting(CODES_KEY, {})));
  codesLoaded = true;
}

async function saveCodes(codes) {
  if (codes.size === 0) return;
  const stored = await getSetting(CODES_KEY, {});
  for (const { key, day, votes } of codes.values()) {
    const c = stored[key] || { days: [], votes: {} };
    if (c.days.includes(day)) continue;
    c.days = [...c.days, day].sort().slice(-CODE_DAYS_KEPT);
    for (const [code, n] of Object.entries(votes)) c.votes[code] = (c.votes[code] || 0) + n;
    stored[key] = c;
  }
  await setSetting(CODES_KEY, stored, null);
  dir.setLearned(claimCodes(stored));
  codesLoaded = true;
}

// The court a case began in: from its number's code, else the one picked
// (when it's the same kind of court as the number).
function originCourt(k, number) {
  const coded = dir.byCode(src.numberCode(number));
  if (coded) return coded;
  const picked = dir.byKey(k.courtKey);
  const type = src.numberType(number);
  return picked && (!type || picked.type === type) ? picked : null;
}

// What to read for a case: { number, origin, watch: [{court, day}], region }
// — `region` when its region's courts are to be looked through (no court
// known: by its number, or by the client's name when it has none).
function planFor(k, today, { onDemand = false } = {}) {
  const number = src.normalizeNumber(k.number) || null;
  const origin = number ? originCourt(k, number) : dir.byKey(k.courtKey);
  const watch = [];
  if (number && origin) {
    for (const court of dir.chain(origin)) {
      const n = onDemand && court.key !== origin.key ? HIGHER_DAYS : src.AHEAD_DAYS[court.type];
      for (const day of daysAhead(today, n)) watch.push({ court, day });
    }
  }
  const lookAround = !(number && origin) && !PRE_COURT.includes(k.legalStage);
  const region = lookAround ? origin?.region || dir.regionOf(k.court) || dir.regionOf(k.client.city) || DEFAULT_REGION : null;
  return { number, origin, watch, region };
}

function regionLists(region, today, onDemand) {
  const out = [];
  for (const court of dir.inRegion(region, Object.keys(NAME_DAYS))) {
    for (const day of daysAhead(today, onDemand ? ON_DEMAND_NAME_DAYS : NAME_DAYS[court.type])) out.push({ court, day });
  }
  return out;
}

const CASE_SELECT = {
  id: true,
  clientId: true,
  number: true,
  court: true,
  courtKey: true,
  legalStage: true,
  matter: true,
  client: { select: { name: true, city: true } },
  dates: { where: { deletedAt: null, kind: "hearing" }, select: { id: true, date: true, time: true, place: true, title: true, note: true, outcome: true, sudKey: true } },
  courtFinds: { select: { number: true, state: true } },
};
// The same, read again just before acting on it.
const FRESH_SELECT = { ...CASE_SELECT, status: true, client: { select: { name: true, city: true, archivedAt: true } } };

const byWhen = (a, b) => (a.date === b.date ? (a.time ?? -1) - (b.time ?? -1) : a.date < b.date ? -1 : 1);
const courtOfKey = (sudKey) => String(sudKey || "").split("|")[0];
const numberOfKey = (sudKey) => String(sudKey || "").split("|").slice(1).join("|");

// One thing at a time per case — the night's run, a check someone pressed,
// an answer — so none of them acts on a case another has just changed.
const caseLocks = new Map();
function withCase(caseId, fn) {
  const done = (caseLocks.get(caseId) || Promise.resolve()).then(() => fn());
  const tail = done.catch(() => {});
  caseLocks.set(caseId, tail);
  tail.then(() => caseLocks.get(caseId) === tail && caseLocks.delete(caseId));
  return done;
}

// "РАХМАТОВ АБРОР АЛИЕВИЧ" -> "Rahmatov Abror Aliyevich".
function personName(value) {
  if (!value) return null;
  return dir
    .latin(value)
    .toLowerCase()
    .replace(/(^|[\s-])(\S)/g, (m, sep, ch) => sep + ch.toUpperCase());
}

const dateNote = (f) => [f.judge ? `Sudya: ${personName(f.judge)}` : null, "sud.uz roʻyxatidan"].filter(Boolean).join(" · ");

// Brings a numbered case's hearings in line with what the courts list for it
// (`found`: rows with their court). `readOk`: "court key|day" of the lists
// read — a hearing Ledger followed that's missing from one of those moved or
// went. `k`: the case as it is now (read under withCase). Returns what
// changed, for the messages.
async function reconcile(db, k, found, { today, readOk = new Set(), origin = null } = {}) {
  const out = { added: [], moved: [], changed: [], gone: [], stage: null };
  const number = src.normalizeNumber(k.number);
  const seen = new Set();
  const rows = [...found].filter((f) => (seen.has(`${f.court.key}|${f.date}|${f.time}`) ? false : seen.add(`${f.court.key}|${f.date}|${f.time}`))).sort(byWhen);
  // Ledger's own coming hearings under a number the case no longer has (it
  // was corrected): someone else's, removed while nothing's written on them.
  const stale = k.dates.filter((d) => d.sudKey && numberOfKey(d.sudKey) !== number && d.date >= today && !d.outcome);
  const live = k.dates.filter((d) => !stale.includes(d));
  const future = live.filter((d) => d.date >= today);
  const used = new Set();
  const pending = [];
  await db.$transaction(async (tx) => {
    const event = (kind, data) => tx.clientEvent.create({ data: { clientId: k.clientId, caseId: k.id, kind, text: "", data: { ...data, via: "sud" } } });
    for (const d of stale) {
      await tx.caseDate.update({ where: { id: d.id }, data: { deletedAt: new Date() } });
      await event("date_row", { action: "remove", kind: "hearing", date: d.date, title: d.title });
    }
    for (const f of rows) {
      const key = `${f.court.key}|${f.number}`;
      // The same hearing, followed already or typed in by hand (a past one
      // too — a "yes" to an old question mustn't add it twice).
      const same = live.find((d) => !used.has(d.id) && d.sudKey === key && d.date === f.date) || live.find((d) => !used.has(d.id) && !d.sudKey && d.date === f.date);
      if (!same) {
        pending.push(f);
        continue;
      }
      used.add(same.id);
      const data = { sudKey: key, sudSeenAt: new Date() };
      if (f.time != null && same.time !== f.time) data.time = f.time;
      if (!same.place) data.place = f.court.nameLatin;
      if (!same.title && TITLES[f.stage]) data.title = TITLES[f.stage];
      await tx.caseDate.update({ where: { id: same.id }, data });
      if (data.time !== undefined && same.time != null) {
        out.changed.push({ row: same, f });
        await event("date_row", { action: "edit", kind: "hearing", date: f.date, time: f.time, title: data.title ?? same.title, before: { date: same.date, time: same.time } });
      }
    }
    // Followed before, not on its day's list now: moved (the court lists it
    // on another day) or gone.
    const missing = future.filter((d) => d.sudKey && !used.has(d.id) && readOk.has(`${courtOfKey(d.sudKey)}|${d.date}`));
    for (const d of missing) {
      const i = pending.findIndex((f) => f.court.key === courtOfKey(d.sudKey));
      if (i === -1) {
        out.gone.push(d);
        continue;
      }
      const [f] = pending.splice(i, 1);
      await tx.caseDate.update({
        where: { id: d.id },
        data: { date: f.date, time: f.time, sudKey: `${f.court.key}|${f.number}`, sudSeenAt: new Date(), ...(TITLES[f.stage] ? { title: TITLES[f.stage] } : {}) },
      });
      if (f.date === d.date && f.time === d.time) continue;
      out.moved.push({ row: d, f });
      await event("date_row", { action: "edit", kind: "hearing", date: f.date, time: f.time, title: TITLES[f.stage] ?? d.title, before: { date: d.date, time: d.time } });
    }
    for (const f of pending) {
      const created = await tx.caseDate.create({
        data: { caseId: k.id, kind: "hearing", date: f.date, time: f.time, title: TITLES[f.stage] ?? null, place: f.court.nameLatin, note: dateNote(f), sudKey: `${f.court.key}|${f.number}`, sudSeenAt: new Date() },
      });
      out.added.push({ row: created, f });
      await event("date_row", { action: "add", kind: "hearing", date: created.date, time: created.time, title: created.title });
    }
    // Further along than the case says: appeal, cassation…
    const top = rows.filter((f) => f.stage).sort((a, b) => STAGE_INDEX.get(b.stage) - STAGE_INDEX.get(a.stage))[0];
    if (top && (k.legalStage == null || STAGE_INDEX.get(top.stage) > STAGE_INDEX.get(k.legalStage))) {
      await tx.caseStage.create({ data: { caseId: k.id, stage: top.stage, date: today, court: top.court.nameLatin, note: "sud.uz roʻyxatidan" } });
      await history.syncCaseStage(tx, k.id, today);
      await event("stage_row", { action: "add", stage: top.stage, date: today });
      out.stage = { stage: top.stage, court: top.court };
    }
    // The court, when the case didn't say.
    const data = {};
    const first = origin || rows.find((f) => f.stage === "first_instance")?.court || rows[0]?.court;
    if (!k.courtKey && first) data.courtKey = first.key;
    if (!k.court && !out.stage && rows[0]) data.court = rows.at(-1).court.nameLatin;
    if (Object.keys(data).length) await tx.clientCase.update({ where: { id: k.id }, data });
    if (stale.length || out.added.length || out.moved.length || out.changed.length || out.stage) await tx.client.update({ where: { id: k.clientId }, data: { updatedAt: new Date() } });
  });
  return out;
}

// ------------------------------------------------------------ messages
const f = () => require("../telegram/format");
const when = (date, time) => `${f().day(date)}${time != null ? `, ${f().clock(time)}` : ""}`;
const whose = (k) => `${f().escapeHtml(k.client.name)}${k.matter ? ` · ${f().escapeHtml(k.matter)}` : ""}`;
const openLink = (k, label = "Ishni ochish") => f().portalLink(`/clients/${k.clientId}?case=${k.id}&section=dates`, label);
const lines = (...parts) => parts.filter(Boolean).join("\n");

function changeMessages(k, out) {
  const e = f().escapeHtml;
  const msgs = [];
  for (const { row, f: h } of out.added) {
    msgs.push({
      key: `sud-add:${row.id}`,
      text: lines(`⚖️ <b>Sud majlisi belgilandi</b>`, when(h.date, h.time), e([h.court.nameLatin, TITLES[h.stage]].filter(Boolean).join(" · ")), h.judge ? `Sudya: ${e(personName(h.judge))}` : null, whose(k), `<i>sud.uz roʻyxatidan</i>`, openLink(k)),
    });
  }
  for (const { row, f: h } of out.moved) {
    msgs.push({ key: `sud-move:${row.id}:${h.date}:${h.time}`, text: lines(`⚖️ <b>Sud majlisi koʻchirildi</b>`, `${when(row.date, row.time)} → <b>${when(h.date, h.time)}</b>`, e(h.court.nameLatin), whose(k), openLink(k)) });
  }
  for (const { row, f: h } of out.changed) {
    msgs.push({ key: `sud-time:${row.id}:${h.date}:${h.time}`, text: lines(`⚖️ <b>Sud majlisi vaqti oʻzgardi</b>`, `${f().day(h.date)}: ${f().clock(row.time)} → <b>${f().clock(h.time)}</b>`, e(h.court.nameLatin), whose(k), openLink(k)) });
  }
  for (const row of out.gone) {
    msgs.push({
      key: `sud-gone:${row.id}:${row.date}`,
      text: lines(`⚠️ <b>Sud majlisi sud.uz roʻyxatida yoʻq</b>`, when(row.date, row.time), row.place ? e(row.place) : null, whose(k), "Qoldirilgan yoki koʻchirilgan boʻlishi mumkin — sud bilan aniqlang.", openLink(k)),
    });
  }
  if (out.stage) {
    msgs.push({ key: `sud-stage:${k.id}:${out.stage.stage}`, text: lines(`📈 <b>Ish yangi bosqichda: ${e(STAGE_WORDS[out.stage.stage])}</b>`, e(out.stage.court.nameLatin), whose(k), `<i>sud.uz roʻyxatidan</i>`, openLink(k)) });
  }
  return msgs;
}

// The people who hear about a case: its lawyers and coordinator; nobody on
// it yet — the boss.
async function audience(db, caseId) {
  const people = await require("../outcomes").peopleOf(caseId, db);
  if (people.length) return people;
  return (await db.user.findMany({ where: { active: true, role: "BOSS" }, select: { id: true } })).map((u) => u.id);
}

// `tag`: what the bell keeps them under (a question's go once it's answered).
async function tell(db, caseId, msgs, { skip = null, buttons = null, tag = null } = {}) {
  if (!msgs.length) return;
  const { notifyUser, once } = require("../telegram/notify");
  for (const userId of await audience(db, caseId)) {
    if (userId === skip) continue;
    for (const m of msgs) await once(`${m.key}:${userId}`, () => notifyUser(userId, "hearings", m.text, buttons ? buttons(m) : undefined, tag ? { appExtra: { tag } } : undefined));
  }
}

// ------------------------------------------------------------ "is this ours?"
const SIDE_WORDS = { claimant: "daʼvogar / jabrlanuvchi", defendant: "javobgar / ayblanuvchi" };
// A question unanswered this long after its hearing: closed, its details wiped.
const ASK_KEEP_DAYS = 14;
const WIPED = { parties: Prisma.DbNull, judge: null, category: null, side: null };
const askTag = (findId) => `court-find:${findId}`;

// The question as Telegram and the bell carry it: the client, the court, the
// number and day — nothing about the other people or what the case is about
// (that's on the case page only, while it's asked).
function askMessage(k, find) {
  const e = f().escapeHtml;
  const court = dir.byKey(find.courtKey);
  return lines(
    `🔎 <b>Sud.uz: bu bizning mijozmi?</b>`,
    `${e(k.client.name)}${find.side ? ` — ${SIDE_WORDS[find.side]}` : ""}`,
    court ? e(dir.label(court)) : null,
    `№ ${e(find.number)}`,
    `${when(find.date, find.time)}${TITLES[find.stage] ? ` · ${TITLES[find.stage]}` : ""}`,
    "Ha — Ledger shu ishni sud.uz dan oʻzi kuzatadi.",
    openLink(k, "Ishni ochish")
  );
}

const askButtons = (findId) => ({ reply_markup: { inline_keyboard: [[{ text: "✅ Ha, bizniki", callback_data: `court:yes:${findId}` }, { text: "Yoʻq", callback_data: `court:no:${findId}` }]] } });

// Questions done with (answered, closed): out of everyone's bell.
async function clearAsks(db, caseId, findIds) {
  if (!findIds.length) return;
  const { count } = await db.notice.deleteMany({ where: { tag: { in: findIds.map(askTag) } } });
  if (count) require("../live").bump(await audience(db, caseId));
}

// Questions nobody answered, their hearing long past: closed and wiped.
async function expireAsks(db, today) {
  const old = await db.courtFind.findMany({ where: { state: "asking", date: { lt: shiftDate(today, -ASK_KEEP_DAYS) } }, select: { id: true, caseId: true } });
  if (!old.length) return 0;
  await db.courtFind.updateMany({ where: { id: { in: old.map((x) => x.id) }, state: "asking" }, data: { state: "closed", ...WIPED } });
  for (const x of old) await clearAsks(db, x.caseId, [x.id]);
  return old.length;
}

// A case with no number: the hearings in its region's lists that name the
// client — asked about once per number, at most MAX_OPEN_ASKS open at once.
async function ask(db, k, candidates, taken) {
  const first = new Map();
  for (const c of [...candidates].sort((a, b) => byWhen(a.row, b.row))) if (!first.has(c.row.number)) first.set(c.row.number, c);
  const asked = new Set(k.courtFinds.map((x) => x.number));
  let open = k.courtFinds.filter((x) => x.state === "asking").length;
  let made = 0;
  for (const [number, { row, court, side }] of first) {
    if (asked.has(number) || taken.has(number) || open >= MAX_OPEN_ASKS) continue;
    let find;
    try {
      find = await db.courtFind.create({
        data: { caseId: k.id, courtKey: court.key, number, date: row.date, time: row.time, judge: row.judge, stage: row.stage, instance: row.instance, category: row.category, side, parties: row.parties },
      });
    } catch (err) {
      if (err.code === "P2002") continue;
      throw err;
    }
    open += 1;
    made += 1;
    await tell(db, k.id, [{ key: `sud-ask:${find.id}`, text: askMessage(k, find) }], { buttons: () => askButtons(find.id), tag: askTag(find.id) });
  }
  return made;
}

// ------------------------------------------------------------ a run
// `caseId`: only that case; `names: false`: numbers only; `onDemand`:
// shorter look-ahead above the first court. Returns what happened.
async function run({ db = prisma, now = firmNow(), get, pauseMs, caseId = null, names = true, onDemand = false } = {}) {
  const today = now.date;
  await loadCodes();
  const reader = makeReader({ get, pauseMs });
  const cases = await db.clientCase.findMany({ where: { status: "contract", client: { archivedAt: null }, ...(caseId ? { id: caseId } : {}) }, select: CASE_SELECT });
  const plans = cases.map((k) => ({ k, ...planFor(k, today, { onDemand }) })).filter((p) => p.watch.length || (p.region && (p.number || names)));

  // The lists: the followed cases' first, then the regions looked through.
  const regions = new Map();
  for (const p of plans) if (p.region && !regions.has(p.region)) regions.set(p.region, regionLists(p.region, today, onDemand));
  const want = [...plans.flatMap((p) => p.watch), ...[...regions.values()].flat()];
  const unique = [...new Map(want.map((w) => [src.listUrl(w.court, w.day), w])).values()];
  if (unique.length > MAX_LISTS) console.warn(`[courts] ${unique.length} lists wanted, reading the first ${MAX_LISTS}`);
  for (const { court, day } of unique.slice(0, MAX_LISTS)) await reader.read(court, day);
  try {
    await saveCodes(reader.codes);
  } catch (err) {
    console.error("[courts] court codes not saved:", err.message);
  }

  // Numbers the firm's cases already have: a name found under one of them
  // is that case's, not a question for another.
  const taken = new Set((await db.clientCase.findMany({ where: { number: { not: null } }, select: { number: true } })).map((r) => src.normalizeNumber(r.number)).filter(Boolean));
  const summary = { cases: plans.length, added: 0, moved: 0, changed: 0, gone: 0, stages: 0, asked: 0, skipped: 0, expired: await expireAsks(db, today) };
  for (const p of plans) {
    try {
      // The lists took minutes: the case as it is now. Changed meanwhile
      // (another number or court, closed, answered) — left to the check
      // that change started.
      await withCase(p.k.id, async () => {
        const k = await db.clientCase.findUnique({ where: { id: p.k.id }, select: FRESH_SELECT });
        if (!k || k.status !== "contract" || k.client.archivedAt || (src.normalizeNumber(k.number) || null) !== p.number || k.courtKey !== p.k.courtKey) {
          summary.skipped += 1;
          return;
        }
        const sources = [...p.watch, ...(p.region ? regions.get(p.region) : [])];
        if (p.number) {
          const found = [];
          const readOk = new Set();
          for (const { court, day } of sources) {
            const rows = reader.rowsOf(court, day);
            if (!rows) continue;
            readOk.add(`${court.key}|${day}`);
            for (const row of rows) if (row.number === p.number) found.push({ ...row, court });
          }
          const out = await reconcile(db, k, found, { today, readOk, origin: p.origin });
          summary.added += out.added.length;
          summary.moved += out.moved.length;
          summary.changed += out.changed.length;
          summary.gone += out.gone.length;
          summary.stages += out.stage ? 1 : 0;
          await tell(db, k.id, changeMessages(k, out));
        } else if (names && p.region) {
          const candidates = [];
          for (const { court, day } of sources) {
            for (const row of reader.rowsOf(court, day) || []) {
              const side = src.sideOf(row, k.client.name);
              if (side) candidates.push({ row, court, side });
            }
          }
          summary.asked += await ask(db, k, candidates, taken);
        }
      });
    } catch (err) {
      console.error(`[courts] case ${p.k.id}:`, err.message);
    }
  }
  return { ...summary, read: reader.stats.read, failed: reader.stats.failed, ...(reader.stats.paused ? { paused: true } : {}) };
}

// One case, now (its number or court was just set, "check now"): a shorter
// look above its first court. Asked again while one runs (a number
// corrected straight after): run once more when it ends.
const checking = new Map();
async function checkCase(caseId, opts = {}) {
  if (checking.has(caseId)) {
    checking.get(caseId).again = opts;
    return { busy: true };
  }
  const state = { again: null };
  checking.set(caseId, state);
  try {
    let result = await run({ ...opts, caseId, onDemand: true });
    while (state.again) {
      const next = state.again;
      state.again = null;
      result = await run({ ...next, caseId, onDemand: true });
    }
    return result;
  } finally {
    checking.delete(caseId);
  }
}

// After a change to a case's number or court (routes/clients.js): checked in
// the background; a failure is only logged.
function checkSoon(caseId) {
  if (!enabled()) return;
  setImmediate(() => checkCase(caseId, { names: false }).catch((err) => console.error(`[courts] check of case ${caseId} failed:`, err.message)));
}

// ------------------------------------------------------------ answers
class FindError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ANSWER_ROLES = ["manager", "lawyer", "coordinator"];
const FIND_CASE = {
  select: { ...CASE_SELECT, status: true, operatorId: true, coordinatorId: true, lawyerId: true, extraLawyers: EXTRA_LAWYERS, client: { select: { name: true, city: true, archivedAt: true, createdById: true, cases: { select: { operatorId: true } } } } },
};

// "Is this our client?" answered — in the portal or by a Telegram button.
// Yes: the case takes the number (and its court), the hearing goes into its
// dates at once, and the rest of its lists are read in the background. No:
// not asked again; the people's names and the rest are wiped. Returns
// { state, already? }.
async function answer(findId, user, ours, { db = prisma, now = firmNow(), background = enabled() } = {}) {
  const first = await db.courtFind.findUnique({ where: { id: findId }, select: { caseId: true } });
  if (!first) throw new FindError(404, "not_found");
  const result = await withCase(first.caseId, async () => {
    const find = await db.courtFind.findUnique({ where: { id: findId }, include: { case: FIND_CASE } });
    if (!find) throw new FindError(404, "not_found");
    const role = caseRole(user, find.case, find.case.client);
    if (!role) throw new FindError(404, "not_found");
    if (!ANSWER_ROLES.includes(role)) throw new FindError(403, "forbidden");
    if (find.state !== "asking") return { state: find.state, already: true };
    await loadCodes();
    // Only a signed case still in work is followed.
    if (find.case.status !== "contract" || find.case.client.archivedAt) throw new FindError(409, "case_closed");
    const answered = { answeredById: user.id, answeredAt: new Date() };
    if (!ours) {
      await db.courtFind.update({ where: { id: find.id }, data: { state: "not_ours", ...WIPED, ...answered } });
      return { state: "not_ours", cleared: [find.id] };
    }
    const k = find.case;
    const origin = dir.byCode(src.numberCode(find.number)) || dir.byKey(find.courtKey);
    const others = await db.courtFind.findMany({ where: { caseId: k.id, state: "asking", id: { not: find.id } }, select: { id: true } });
    await db.$transaction(async (tx) => {
      await tx.courtFind.update({ where: { id: find.id }, data: { state: "ours", ...answered } });
      // One number per case: the other questions about it are closed.
      await tx.courtFind.updateMany({ where: { id: { in: others.map((x) => x.id) } }, data: { state: "closed", ...WIPED } });
      const data = {};
      if (!k.number) data.number = find.number;
      if (!k.courtKey && origin) data.courtKey = origin.key;
      if (Object.keys(data).length) await tx.clientCase.update({ where: { id: k.id }, data });
      if (data.number) {
        await tx.clientEvent.create({ data: { clientId: k.clientId, caseId: k.id, kind: "case_edit", text: "", data: { changes: [{ field: "number", from: null, to: data.number }], via: "sud" }, authorId: user.id } });
        await require("../../lib/clientsDb").refreshSearch(tx, k.clientId);
      }
    });
    // The hearing it was found with, straight into the case.
    const fresh = await db.clientCase.findUnique({ where: { id: k.id }, select: FRESH_SELECT });
    const court = dir.byKey(find.courtKey);
    if (court && src.normalizeNumber(fresh.number) === find.number) {
      const row = { number: find.number, date: find.date, time: find.time, judge: find.judge, stage: find.stage, instance: find.instance, court };
      const out = await reconcile(db, fresh, [row], { today: now.date, origin });
      await tell(db, k.id, changeMessages(fresh, out), { skip: user.id });
    }
    return { state: "ours", cleared: [find.id, ...others.map((x) => x.id)] };
  });
  if (result.cleared) await clearAsks(db, first.caseId, result.cleared);
  if (result.state === "ours" && !result.already && background) {
    setImmediate(() => checkCase(first.caseId, { names: false }).catch((err) => console.error(`[courts] check of case ${first.caseId} failed:`, err.message)));
  }
  return { state: result.state, ...(result.already ? { already: true } : {}) };
}

// The questions waiting for this person: the cases they may answer for.
async function waitingFor(user, { db = prisma, caseId = null } = {}) {
  const scope = require("../outcomes").dueScope(user);
  if (!scope) return [];
  const rows = await db.courtFind.findMany({
    where: { state: "asking", case: { ...scope, ...(caseId ? { id: caseId } : {}), status: "contract", client: { archivedAt: null } } },
    orderBy: [{ date: "asc" }, { id: "asc" }],
    take: 50,
    include: { case: { select: { id: true, clientId: true, matter: true, client: { select: { name: true } } } } },
  });
  return rows.map(publicFind);
}

function publicFind(x) {
  const court = dir.byKey(x.courtKey);
  return {
    id: x.id,
    caseId: x.caseId,
    clientId: x.case?.clientId,
    clientName: x.case?.client?.name,
    matter: x.case?.matter ?? null,
    court: court ? dir.publicCourt(court) : { key: x.courtKey, name: x.courtKey },
    number: x.number,
    date: x.date,
    time: x.time,
    judge: personName(x.judge),
    stage: x.stage,
    category: x.category,
    side: x.side,
    parties: x.parties,
    createdAt: x.createdAt,
  };
}

// ------------------------------------------------------------ the clock
// Every 15 minutes (services/scheduler.js): the whole run once between 03:00
// and 06:00, numbers only once between 13:00 and 15:00. A run that reads
// nothing at all, or that sud.uz stopped answering, tells the developers.
async function tick(now = firmNow()) {
  if (!enabled()) return;
  const hour = Math.floor(now.minutes / 60);
  const status = await getSetting(STATUS_KEY, {});
  let which = null;
  if (hour >= 3 && hour < 6 && status.fullOn !== now.date) which = "fullOn";
  else if (hour >= 13 && hour < 15 && status.numbersOn !== now.date) which = "numbersOn";
  if (!which) return;
  // Marked first: a run that fails isn't started again every 15 minutes.
  await setSetting(STATUS_KEY, { ...status, [which]: now.date }, null);
  const started = Date.now();
  const summary = await run({ now, names: which === "fullOn" });
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`[courts] ${which === "fullOn" ? "nightly" : "midday"} run: ${summary.read} lists read (${summary.failed} failed) in ${seconds}s; ${summary.added} new, ${summary.moved} moved, ${summary.changed} new times, ${summary.gone} gone, ${summary.stages} stages, ${summary.asked} questions`);
  await setSetting(STATUS_KEY, { ...(await getSetting(STATUS_KEY, {})), last: { at: new Date().toISOString(), seconds, ...summary } }, null);
  if (summary.paused || (summary.failed > 0 && summary.read === 0)) {
    const { notifyUser, once, linkedUsers } = require("../telegram/notify");
    const text = summary.paused
      ? lines("⚠️ <b>sud.uz javob bermay qoldi</b>", `${summary.read} ta roʻyxat oʻqildi, keyin sud.uz javob bermadi — 3 soat tegmaymiz, qolgani keyingi safar.`, "Sayt ishlamayapti yoki serverimizni toʻsib qoʻygan boʻlishi mumkin.")
      : lines("⚠️ <b>sud.uz oʻqilmadi</b>", `${summary.failed} ta roʻyxatdan birortasi ham ochilmadi — sud majlislari bugun yangilanmadi.`, "Sayt ishlamayapti yoki manzillari oʻzgargan boʻlishi mumkin.");
    for (const dev of await linkedUsers({ role: "DEVELOPER" })) {
      await once(`sud-down:${now.date}:${dev.id}`, () => notifyUser(dev, null, text));
    }
  }
}

// When sud.uz is next asked, if it's being left alone now; else null.
const pausedUntil = () => (gate.coolUntil > Date.now() ? new Date(gate.coolUntil).toISOString() : null);

module.exports = { enabled, daysAhead, makeReader, gate, claimCodes, pausedUntil, originCourt, planFor, reconcile, run, checkCase, checkSoon, answer, waitingFor, publicFind, tick, personName, FindError, STATUS_KEY, CODES_KEY, TITLES };
