// Builds Ledger's list of Uzbekistan's courts on sud.uz
// (src/services/courts/directory.json), from the Supreme Court's own hearing
// schedule site, jadval2.sud.uz: every court's id there, its name, its region
// and whether it's a district, regional or the Supreme Court.
//
//   node scripts/court-directory.js
//
// Each court's code in its case numbers (2-1001-2607/59591: 1001) isn't
// learned here any more: the server learns it from the lists it reads
// anyway (services/courts/sync.js). Reading every court's list at once
// got this PC refused by sud.uz on 2026-10-29.
//
// Run it again when sud.uz adds or renames courts; the file is committed.

const fs = require("node:fs");
const path = require("node:path");
// No database here: the rules it shares with the server only want these set.
process.env.DATABASE_URL ??= "file:unused";
process.env.JWT_SECRET ??= "unused";
const { TYPES } = require("../src/services/courts/sources");

const SITE = "https://jadval2.sud.uz";
const REGIONS = ["toshkent", "toshkentvil", "andijon", "buxoro", "fargona", "jizzax", "namangan", "navoiy", "qashqadaryo", "qoraqalpoq", "samarqand", "sirdaryo", "surxondaryo", "xorazm"];
const OUT = path.join(__dirname, "..", "src", "services", "courts", "directory.json");
const PAUSE_MS = 1500;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function page(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

// The court buttons on one of the site's pages: { id, name } in page order.
function buttons(html) {
  return [...html.matchAll(/<button[^>]*\bid\s*=\s*"([^"]+)"[^>]*\bvalue="([^"]+)"/g)].map((m) => ({ id: m[1].trim(), name: m[2].trim() }));
}

async function crawl() {
  const courts = [];
  for (const [type, t] of Object.entries(TYPES)) {
    const top = buttons(await page(`${SITE}/${t.section}/regions.html`));
    for (const c of top) courts.push({ key: `${type}:${c.id}`, type, id: c.id, name: c.name, region: null, level: "supreme" });
    for (const region of REGIONS) {
      await pause(PAUSE_MS);
      // A region's page: its regional court first, then the district ones.
      buttons(await page(`${SITE}/${t.section}/${region}-dis.html`)).forEach((c, i) => {
        courts.push({ key: `${type}:${c.id}`, type, id: c.id, name: c.name, region, level: i === 0 ? "region" : "district" });
      });
    }
    console.log(`${type}: ${courts.filter((c) => c.type === type).length} courts`);
  }
  // The same court listed twice (it happens on the site): once.
  const seen = new Set();
  return courts.filter((c) => (seen.has(c.key) ? false : seen.add(c.key)));
}

async function main() {
  const courts = await crawl();
  if (fs.existsSync(OUT)) {
    // Keep the codes written in before.
    const before = new Map(JSON.parse(fs.readFileSync(OUT, "utf8")).courts.map((c) => [c.key, c.code]));
    for (const c of courts) if (before.get(c.key)) c.code = before.get(c.key);
  }
  fs.writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString().slice(0, 10), courts }, null, 1) + "\n");
  console.log(`${courts.length} courts -> ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
