const { evaluateStrikes } = require("./strikes");
const { evaluateSummaryStrikes } = require("./consultSummary");
const { archiveQuietClients } = require("./clientArchive");
const { syncDueStages } = require("./caseHistory");
const prisma = require("../lib/prisma");
const { firmNow } = require("../lib/firmTime");

// Work done on a clock, whatever else is configured (the Telegram bot has its
// own clock for messages — src/services/telegram/jobs.js):
//   every 5 minutes  late call-back strikes (services/strikes.js), and
//                    consultation summaries not written in time
//                    (services/consultSummary.js)
//   every hour       consultations gone quiet to the archive (services/clientArchive.js);
//                    planned case stages whose day has come (services/caseHistory.js)
//   every 10 minutes covers for lawyers who are away begin and end on their
//                    days (services/covers.js); lost callers' second chance
//                    (services/callOutcomes.js)
// Each run waits for the previous one; an error is logged, never thrown.

const STRIKES_EVERY_MS = 5 * 60 * 1000;
let running = false;

async function strikesTick() {
  if (running) return;
  running = true;
  try {
    const { created, cancelled } = await evaluateStrikes();
    if (created || cancelled) console.log(`[strikes] ${created} given, ${cancelled} cancelled (call-back found)`);
  } catch (err) {
    console.error("[strikes] check failed:", err.message);
  }
  try {
    const { created } = await evaluateSummaryStrikes();
    if (created) console.log(`[summaries] ${created} strike(s) for summaries not written in time`);
  } catch (err) {
    console.error("[summaries] check failed:", err.message);
  } finally {
    running = false;
  }
}

const ARCHIVE_EVERY_MS = 60 * 60 * 1000;
let archiving = false;

async function archiveTick() {
  if (archiving) return;
  archiving = true;
  try {
    const n = await archiveQuietClients();
    if (n) console.log(`[clients] ${n} quiet consultation(s) moved to the archive`);
  } catch (err) {
    console.error("[clients] automatic archive failed:", err.message);
  }
  try {
    const n = await syncDueStages(prisma, firmNow().date);
    if (n) console.log(`[cases] ${n} case(s) reached a planned stage`);
  } catch (err) {
    console.error("[cases] planned stages failed:", err.message);
  } finally {
    archiving = false;
  }
}

// Claude's reports on their days (services/ai/reports.js) — each only when
// switched on in Sozlamalar.
const AI_EVERY_MS = 5 * 60 * 1000;
let reporting = false;

async function aiTick() {
  if (reporting) return;
  reporting = true;
  try {
    await require("./ai/reports").tick();
  } catch (err) {
    console.error("[claude] scheduled report failed:", err.message);
  } finally {
    reporting = false;
  }
}

// What's new after a release, and the developer's note on each release
// (services/news.js).
const NEWS_EVERY_MS = 2 * 60 * 1000;
async function newsTick() {
  try {
    const news = require("./news");
    await news.deployTick();
    await news.newsTick();
  } catch (err) {
    console.error("[news] failed:", err.message);
  }
}

// Covers for lawyers who are away (services/covers.js).
const COVERS_EVERY_MS = 10 * 60 * 1000;
async function coversTick() {
  try {
    await require("./covers").syncCovers();
  } catch (err) {
    console.error("[covers] failed:", err.message);
  }
}

// The AI review of the firm's Telegram chats (beta, services/tgReview.js).
const TG_REVIEW_EVERY_MS = 10 * 60 * 1000;
let tgReviewing = false;
async function tgReviewTick() {
  if (tgReviewing) return;
  tgReviewing = true;
  try {
    await require("./tgReview").tick();
  } catch (err) {
    console.error("[tg-review] failed:", err.message);
  } finally {
    tgReviewing = false;
  }
}

// Operators' calls turned into text but not reviewed yet (services/callReview.js).
const CALL_REVIEW_EVERY_MS = 5 * 60 * 1000;
let callReviewing = false;
async function callReviewTick() {
  if (callReviewing) return;
  callReviewing = true;
  try {
    await require("./callReview").tick();
  } catch (err) {
    console.error("[call-review] failed:", err.message);
  } finally {
    callReviewing = false;
  }
}

// Lost callers whose second chance is due -> the next operator in turn
// (services/callOutcomes.js).
const SECOND_CHANCE_EVERY_MS = 10 * 60 * 1000;
let secondChancing = false;
async function secondChanceTick() {
  if (secondChancing) return;
  secondChancing = true;
  try {
    const given = await require("./callOutcomes").secondChances();
    if (given) console.log(`[second-chance] ${given} given`);
  } catch (err) {
    console.error("[second-chance] failed:", err.message);
  } finally {
    secondChancing = false;
  }
}

function start() {
  setTimeout(secondChanceTick, 4 * 60 * 1000).unref();
  setInterval(secondChanceTick, SECOND_CHANCE_EVERY_MS).unref();
  setTimeout(callReviewTick, 3 * 60 * 1000).unref();
  setInterval(callReviewTick, CALL_REVIEW_EVERY_MS).unref();
  setTimeout(tgReviewTick, 2 * 60 * 1000).unref();
  setInterval(tgReviewTick, TG_REVIEW_EVERY_MS).unref();
  setTimeout(coversTick, 40 * 1000).unref();
  setInterval(coversTick, COVERS_EVERY_MS).unref();
  setTimeout(newsTick, 45 * 1000).unref();
  setInterval(newsTick, NEWS_EVERY_MS).unref();
  setTimeout(aiTick, 90 * 1000).unref();
  setInterval(aiTick, AI_EVERY_MS).unref();
  setTimeout(strikesTick, 30 * 1000).unref();
  setInterval(strikesTick, STRIKES_EVERY_MS).unref();
  setTimeout(archiveTick, 60 * 1000).unref();
  setInterval(archiveTick, ARCHIVE_EVERY_MS).unref();
}

module.exports = { start, strikesTick, archiveTick, aiTick, newsTick, coversTick, tgReviewTick, callReviewTick, secondChanceTick };
