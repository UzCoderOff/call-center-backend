// The nightly backup: a local copy of the database, then the same copy —
// encrypted — to Google Drive, with new recordings and materials; then a
// one-line note on Telegram to the developer: "backup OK" or what failed.
// Run from cron (DEPLOY.md, "Backups"):
//
//   npm run backup:offsite            everything
//   npm run backup:offsite -- --db    the database only (quick, e.g. after an update)
//
// Set up once with `npm run backup:offsite-setup`. Without that, only the
// local copy is made and the note says Drive isn't set up.
require("dotenv").config();
const path = require("path");
const prisma = require("../src/lib/prisma");
const env = require("../src/config/env");
const { makeLocalBackup, sendOffsite, offsiteConfigured } = require("../src/services/backup");
const { escapeHtml } = require("../src/services/telegram/format");

const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

// To everyone with the DEVELOPER role who connected Telegram.
async function tellDevelopers(text) {
  if (!env.telegram.token) return;
  const api = require("../src/services/telegram/api");
  const links = await prisma.telegramLink.findMany({ where: { chatId: { not: null }, user: { role: "DEVELOPER", active: true } }, select: { chatId: true } });
  for (const link of links) {
    try {
      await api.sendMessage(link.chatId, text);
    } catch (err) {
      console.error(`telegram note: ${err.message}`);
    }
  }
}

async function main() {
  const dbOnly = process.argv.includes("--db");
  const started = Date.now();
  let local;
  try {
    local = await makeLocalBackup();
    console.log(`backup: ${local.file} (${kb(local.size)})`);
  } catch (err) {
    console.error(`backup FAILED: ${err.message}`);
    await tellDevelopers(`❌ <b>Zaxira nusxa olinmadi</b>\n${escapeHtml(err.message)}`);
    process.exitCode = 1;
    return;
  }

  if (!offsiteConfigured()) {
    console.log("offsite: not set up (npm run backup:offsite-setup) — local copy only");
    await tellDevelopers(`⚠️ Zaxira nusxa faqat serverda: ${path.basename(local.file)} (${kb(local.size)}). Google Drive hali ulanmagan.`);
    return;
  }

  // Each step as it happens (uploading recordings can take minutes).
  const steps = await sendOffsite(local, {
    files: !dbOnly,
    onStep: (s) => console.log(s.started ? `offsite ${s.label}: …` : `offsite ${s.label}: ${s.ok ? "ok" : `FAILED — ${s.error}`} (${s.seconds}s)`),
  });
  const failed = steps.filter((s) => !s.ok);
  const took = Math.round((Date.now() - started) / 1000);
  if (failed.length === 0) {
    await tellDevelopers(`✅ Zaxira nusxa: ${path.basename(local.file)} (${kb(local.size)}) serverda va Google Drive'da (shifrlangan). ${took} soniya.`);
  } else {
    const dbOk = steps.find((s) => s.label === "database")?.ok;
    await tellDevelopers(
      [
        dbOk ? "⚠️ <b>Zaxira nusxa qisman</b> — baza Drive'da, lekin:" : "❌ <b>Zaxira nusxa Drive'ga yuborilmadi</b> (serverdagi nusxa bor):",
        ...failed.map((s) => `• ${s.label}: ${escapeHtml(s.error.slice(0, 300))}`),
      ].join("\n")
    );
    process.exitCode = 1;
  }
}

// Always ends — an open connection must not keep a nightly job alive.
main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    console.log(process.exitCode ? "done, with problems (see above)" : "done");
    process.exit(process.exitCode ?? 0);
  });
