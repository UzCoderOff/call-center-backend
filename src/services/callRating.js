const prisma = require("../lib/prisma");
const { CRITERIA, MAX, LABELS } = require("./callReview");

// An operator's rating from the AI call reviews (beta), like the stars of a
// taxi driver: the average score of their last LIMIT reviewed calls of the
// last WINDOW_DAYS, out of 5 stars, with a word for it, which way it's
// going, and what they do best and worst. Reviews a manager marked
// "Notoʻgʻri" don't count. With fewer than MIN_REVIEWS calls it says so
// instead of a rating — two calls are no measure of anyone.

const WINDOW_DAYS = 60;
const LIMIT = 30;
const MIN_REVIEWS = 5;
// Average score (out of 100) from which each word applies.
const LEVELS = [
  { min: 85, key: "excellent" },
  { min: 70, key: "good" },
  { min: 55, key: "fair" },
  { min: 40, key: "low" },
  { min: 0, key: "veryLow" },
];
// A change of this many points between the older and newer half is a trend.
const TREND_POINTS = 5;

const round1 = (n) => Math.round(n * 10) / 10;
const avg = (list) => list.reduce((a, b) => a + b, 0) / list.length;

// Reviews (newest first: { score, details, at }) -> the rating.
function rate(reviews) {
  const list = reviews.filter((r) => Number.isFinite(r.score)).slice(0, LIMIT);
  if (list.length < MIN_REVIEWS) return { count: list.length, enough: false, needed: MIN_REVIEWS };
  const score = avg(list.map((r) => r.score));
  let trend = "flat";
  if (list.length >= 2 * MIN_REVIEWS) {
    const half = Math.floor(list.length / 2);
    const change = avg(list.slice(0, half).map((r) => r.score)) - avg(list.slice(half).map((r) => r.score));
    if (change >= TREND_POINTS) trend = "up";
    else if (change <= -TREND_POINTS) trend = "down";
  }
  // Each part of the standard as a share of its points.
  const parts = CRITERIA.map((key) => {
    const shares = list
      .map((r) => (r.details?.criteria || []).find((c) => c.key === key))
      .filter((c) => c && Number.isFinite(c.points))
      .map((c) => c.points / MAX[key]);
    return { key, label: LABELS[key], share: shares.length ? Math.round(avg(shares) * 100) : null };
  }).filter((p) => p.share !== null);
  const byShare = [...parts].sort((a, b) => b.share - a.share);
  const gross = list.reduce((n, r) => n + (r.details?.grossErrors?.length || 0), 0);
  return {
    count: list.length,
    enough: true,
    score: Math.round(score),
    stars: round1(score / 20),
    level: LEVELS.find((l) => score >= l.min).key,
    trend,
    parts,
    best: byShare.filter((p) => p.share >= 70).slice(0, 2),
    worst: byShare
      .filter((p) => p.share < 60)
      .slice(-2)
      .reverse(),
    gross,
    since: list[list.length - 1].at,
  };
}

// employeeIds -> Map(employeeId -> rating); only those with any review.
async function ratings(employeeIds, now = new Date()) {
  const out = new Map();
  if (!employeeIds.length) return out;
  const rows = await prisma.callAnalysis.findMany({
    where: {
      status: "done",
      score: { not: null },
      OR: [{ feedbackCorrect: null }, { feedbackCorrect: true }],
      createdAt: { gte: new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000) },
      callLog: { employeeId: { in: employeeIds } },
    },
    orderBy: { callLog: { callTimestampMs: "desc" } },
    select: { score: true, details: true, callLog: { select: { employeeId: true, callTimestampMs: true } } },
  });
  const byEmployee = new Map();
  for (const r of rows) {
    if (!r.details) continue;
    const id = r.callLog.employeeId;
    if (!byEmployee.has(id)) byEmployee.set(id, []);
    byEmployee.get(id).push({ score: r.score, details: r.details, at: new Date(Number(r.callLog.callTimestampMs)).toISOString() });
  }
  for (const [id, list] of byEmployee) out.set(id, rate(list));
  return out;
}

module.exports = { rate, ratings, LIMIT, MIN_REVIEWS, WINDOW_DAYS };
