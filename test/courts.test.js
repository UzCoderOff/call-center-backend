const test = require("node:test");
const assert = require("node:assert/strict");
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused-secret-for-tests";
const src = require("../src/services/courts/sources");
const dir = require("../src/services/courts/directory");
const sync = require("../src/services/courts/sync");

// The people in these lists are made up.

test("case numbers: written any way, read one way; the court and kind they carry", () => {
  assert.equal(src.normalizeNumber(" № 2-1001-2607/59591 "), "2-1001-2607/59591");
  assert.equal(src.normalizeNumber("2–1001–2607 / 59591"), "2-1001-2607/59591");
  assert.equal(src.numberCode("2-1001-2607/59591"), "2-1001");
  assert.equal(src.numberCode("4-10-2619/123"), "4-10");
  // Older numbers don't say which court.
  assert.equal(src.numberCode("1-111/2016"), null);
  assert.equal(src.numberCode(""), null);
  assert.equal(src.numberType("1-1601-2608/1874"), "criminal");
  assert.equal(src.numberType("3-1007-2603/6755"), "offence");
  assert.equal(src.numberType("4-1001-2619/56028"), "economic");
  assert.equal(src.numberType("5-1001-2606/1865"), "administrative");
  assert.equal(src.numberType("bir nima"), null);
});

test("the court's words for a stage -> Ledger's stages", () => {
  assert.equal(src.stageOf("Биринчи инстанция"), "first_instance");
  assert.equal(src.stageOf("Апелляция инстанцияси"), "appeal");
  assert.equal(src.stageOf("Кассация инстанцияси"), "cassation");
  assert.equal(src.stageOf("Тафтиш"), "review");
  assert.equal(src.stageOf("Олий судда тафтиш"), "supreme_review");
  assert.equal(src.stageOf("nimadir"), null);
});

test("a list's address: the court's id and the day as DDMMYYYY", () => {
  assert.equal(src.listUrl({ type: "criminal", id: "78" }, "2026-10-29"), "https://api4.sud.uz/78/29102026");
  assert.equal(src.listUrl({ type: "civil", id: "mulugtfsud" }, "2026-11-02"), "https://jadvalapi.sud.uz/vka/CIVIL/mulugtfsud/02112026");
  assert.equal(src.listUrl({ type: "economic", id: "toshkent.t" }, "2026-11-02"), "https://jadvalapi.sud.uz/vka/ECONOMIC/toshkent.t/02112026");
});

test("criminal and civil lists read into one shape", () => {
  const criminal = src.parseList("criminal", [
    {
      id: 1,
      defendant: "ТЕСТОВ АЗИЗ БАХОДИР ЎҒЛИ <BR>(169-модда 3-қисми а-банди (Ўғрилик));<BR><BR>НАМУНОВ ЖАСУР <BR>(169-модда 2-қисми (Ўғрилик))",
      claimant: "ЎЙДИРМА ДИЛНОЗА;<BR>ЎЙДИРМА ДИЛНОЗА",
      casenumber: "1-1001-2608/1874",
      hearingdate: "29.10.2026",
      hearingtime: "14:00",
      judge: "Sinovov Anvar",
      instance: "Апелляция инстанцияси",
    },
    { casenumber: "", hearingdate: "29.10.2026" },
  ]);
  assert.equal(criminal.length, 1);
  assert.deepEqual(criminal[0].parties, { claimant: ["ЎЙДИРМА ДИЛНОЗА"], defendant: ["ТЕСТОВ АЗИЗ БАХОДИР ЎҒЛИ", "НАМУНОВ ЖАСУР"] });
  assert.equal(criminal[0].date, "2026-10-29");
  assert.equal(criminal[0].time, 840);
  assert.equal(criminal[0].stage, "appeal");
  assert.match(criminal[0].category, /169-модда 3-қисми а-банди \(Ўғрилик\)/);

  const civil = src.parseList("civil", [
    {
      casenumber: "2-1001-2607/59591",
      hearing_date: "02.11.2026",
      hearing_time: "15:05",
      responsible: "СИНОВОВ АНВАР",
      instance: "Биринчи инстанция",
      category: "Қарз ундиришга доир",
      claiment: "NAMUNOVA MALIKA RUSTAM QIZI",
      defendant: "\"TEST SAVDO\" MAS'ULIYATI CHEKLANGAN JAMIYAT",
    },
  ]);
  assert.equal(civil[0].time, 905);
  assert.equal(civil[0].stage, "first_instance");
  assert.equal(civil[0].category, "Қарз ундиришга доир");
  assert.deepEqual(civil[0].parties.claimant, ["NAMUNOVA MALIKA RUSTAM QIZI"]);
  assert.deepEqual(src.parseList("civil", { message: "Нотўғри сана" }), []);
});

test("a client's name in a list: either script, any order, with the father's name or without", () => {
  assert.ok(src.sameName("Aziz Testov", "ТЕСТОВ АЗИЗ БАХОДИР ЎҒЛИ"));
  assert.ok(src.sameName("Testov Aziz Bahodir oʻgʻli", "ТЕСТОВ АЗИЗ БАХОДИР ЎҒЛИ"));
  assert.ok(src.sameName("Malika Namunova", "NAMUNOVA MALIKA RUSTAM QIZI"));
  // "Yergashev" and "Ергашев", "-yev" and "-ев".
  assert.ok(src.sameName("Sardor Yergashev", "ЕРГАШЕВ САРДОР"));
  assert.ok(src.sameName("Sardor Abdullayev", "АБДУЛЛАЕВ САРДОР"));
  // Another person.
  assert.ok(!src.sameName("Aziz Testov", "ТЕСТОВ АКМАЛ"));
  assert.ok(!src.sameName("Aziz Testov Rustam oʻgʻli", "ТЕСТОВ АЗИЗ БАХОДИР ЎҒЛИ"));
  // One word is too little to go on.
  assert.ok(!src.sameName("Aziz", "ТЕСТОВ АЗИЗ"));
  // A company: by its own name, whatever its legal form is written as.
  assert.ok(src.sameName("Test Savdo MChJ", "\"TEST SAVDO\" MAS'ULIYATI CHEKLANGAN JAMIYAT"));
  assert.ok(src.sameName("Namunasavdo MCHJ", "\"NAMUNASAVDO\" MAS'ULIYATI CHEKLANGAN JAMIYAT"));
  assert.ok(!src.sameName("Nur MChJ", "\"NUR\" MChJ"), "one short word is too common");
  const row = { parties: { claimant: ["NAMUNOVA MALIKA"], defendant: ["ТЕСТОВ АЗИЗ"] } };
  assert.equal(src.sideOf(row, "Aziz Testov"), "defendant");
  assert.equal(src.sideOf(row, "Malika Namunova"), "claimant");
  assert.equal(src.sideOf(row, "Boshqa Odam"), null);
});

test("the court list: Latin names, the courts above a court, a place's region", () => {
  assert.equal(dir.latin("Мирзо Улуғбек туманлараро суди"), "Mirzo Ulugʻbek tumanlararo sudi");
  assert.equal(dir.latin("Тошкент шаҳар суди"), "Toshkent shahar sudi");
  assert.equal(dir.latin("Ергаш"), "Yergash");
  const mu = dir.byKey("civil:mulugtfsud");
  assert.equal(mu.level, "district");
  assert.deepEqual(dir.chain(mu).map((c) => c.key), ["civil:mulugtfsud", "civil:toshfsud", "civil:oliyfsud"]);
  assert.deepEqual(dir.chain(dir.byKey("civil:oliyfsud")).map((c) => c.key), ["civil:oliyfsud"]);
  assert.equal(dir.label(mu), "Mirzo Ulugʻbek tumanlararo sudi (fuqarolik)");
  assert.equal(dir.regionOf("Toshkent"), "toshkent");
  assert.equal(dir.regionOf("Toshkent viloyati, Chirchiq"), "toshkentvil");
  assert.equal(dir.regionOf("Samarqand sh."), "samarqand");
  assert.equal(dir.regionOf("Chilonzor tumani"), "toshkent");
  assert.equal(dir.regionOf(""), null);
  assert.equal(dir.regionOf("Moskva"), null);
  // Every region has its court, in each kind.
  for (const type of ["criminal", "civil", "economic", "administrative"]) assert.equal(dir.all().filter((c) => c.type === type && c.level === "region").length, 14, type);
});

test("what a case's check reads", () => {
  const today = "2026-10-29"; // a Thursday
  // Sundays left out.
  assert.deepEqual(sync.daysAhead(today, 4), ["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-02"]);
  const base = { courtKey: null, court: null, legalStage: "first_instance", client: { name: "Aziz Testov", city: "Samarqand" } };
  // A number with a known court: that court and the ones above, nothing else.
  const mu = dir.byKey("civil:mulugtfsud");
  dir.setLearned(new Map([["2-1001", mu.key]]));
  const p = sync.planFor({ ...base, number: "2-1001-2607/59591" }, today);
  assert.equal(p.origin.key, mu.key);
  assert.equal(p.region, null);
  assert.ok(p.watch.every((w) => dir.chain(mu).some((c) => c.key === w.court.key)));
  dir.setLearned(new Map());
  // Its code not learned yet: the number looked for in the region's courts.
  const unknown = sync.planFor({ ...base, number: "2-1001-2607/59591" }, today);
  assert.equal(unknown.origin, null);
  assert.equal(unknown.region, "samarqand");
  const picked = sync.planFor({ ...base, number: "2-111/2016", courtKey: mu.key }, today);
  assert.equal(picked.origin.key, mu.key);
  assert.equal(new Set(picked.watch.map((w) => w.court.key)).size, 3);
  // A criminal number, a civil court picked: not that court.
  assert.equal(sync.originCourt({ courtKey: mu.key }, "1-111/2016"), null);
  // No number: the client's region, by name.
  const byName = sync.planFor({ ...base, number: null }, today);
  assert.equal(byName.watch.length, 0);
  assert.equal(byName.region, "samarqand");
  // Still with the investigators: nothing to look for.
  assert.equal(sync.planFor({ ...base, number: null, legalStage: "investigation" }, today).region, null);
});

test("judges' names read as people write them", () => {
  assert.equal(sync.personName("СИНОВОВ АНВАР АЛИЕВИЧ"), "Sinovov Anvar Aliyevich");
  assert.equal(sync.personName("Sinovov Anvar"), "Sinovov Anvar");
  assert.equal(sync.personName(null), null);
});

test("court codes: most of a court's own first-instance cases, seen a few times, no other court's", () => {
  const claimed = sync.claimCodes({
    "civil:a": { days: ["2026-10-30"], votes: { "2-1001": 8, "2-1002": 1 } },
    // Too few to tell.
    "civil:b": { days: ["2026-10-30"], votes: { "2-1003": 2 } },
    // No code most of its cases.
    "civil:c": { days: ["2026-10-30"], votes: { "2-1004": 3, "2-1005": 3 } },
    // Two courts claiming one code: neither.
    "civil:d": { days: ["2026-10-30"], votes: { "2-1006": 5 } },
    "civil:e": { days: ["2026-10-30"], votes: { "2-1006": 4 } },
  });
  assert.deepEqual([...claimed], [["2-1001", "civil:a"]]);
  assert.equal(sync.claimCodes(null).size, 0);
});

test("lists read in turn; sud.uz not answering is left alone, a list it says is gone isn't", async () => {
  sync.gate.reset();
  const court = dir.byKey("civil:mulugtfsud");
  const day = (i) => `2026-11-${String(10 + i).padStart(2, "0")}`;
  const row = (number, instance) => ({ casenumber: number, hearing_date: "10.11.2026", hearing_time: "10:00", instance, claiment: "X", defendant: "Y" });
  // Codes counted from first-instance cases only.
  let reader = sync.makeReader({ pauseMs: 0, get: async () => [row("2-1001-2607/1", "Биринчи инстанция"), row("2-1009-2607/2", "Апелляция инстанцияси")] });
  await reader.read(court, day(0));
  assert.deepEqual([...reader.codes.values()], [{ key: court.key, day: day(0), votes: { "2-1001": 1 } }]);
  // Six 404s in a row: sud.uz answering, nothing stopped.
  const gone = Object.assign(new Error("HTTP 404"), { status: 404 });
  reader = sync.makeReader({ pauseMs: 0, get: async () => Promise.reject(gone) });
  for (let i = 0; i < 6; i += 1) await reader.read(court, day(i));
  assert.equal(reader.stats.failed, 6);
  assert.equal(reader.stats.paused, false);
  assert.equal(sync.pausedUntil(), null);
  // Five not answered: the rest not even asked, until later.
  let asked = 0;
  reader = sync.makeReader({ pauseMs: 0, get: async () => (asked++, Promise.reject(new Error("timeout"))) });
  for (let i = 0; i < 9; i += 1) assert.equal(await reader.read(court, day(i)), null);
  assert.equal(asked, 5);
  assert.equal(reader.stats.paused, true);
  assert.ok(sync.pausedUntil());
  // Another run meanwhile: nothing asked either.
  reader = sync.makeReader({ pauseMs: 0, get: async () => (asked++, []) });
  await reader.read(court, day(20));
  assert.equal(asked, 5);
  assert.equal(reader.stats.paused, true);
  sync.gate.reset();
  // One at a time, the pause between, even from two readers at once.
  const at = [];
  const timed = async () => (at.push(Date.now()), []);
  const r1 = sync.makeReader({ pauseMs: 60, get: timed });
  const r2 = sync.makeReader({ pauseMs: 60, get: timed });
  await Promise.all([r1.read(court, day(0)), r2.read(court, day(1)), r1.read(court, day(2))]);
  assert.equal(at.length, 3);
  for (let i = 1; i < at.length; i += 1) assert.ok(at[i] - at[i - 1] >= 55, `gap ${at[i] - at[i - 1]}`);
  sync.gate.reset();
});
