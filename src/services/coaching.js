const prisma = require("../lib/prisma");
const { firmDayRange, shiftDate, weekStartOf, isoWeekday } = require("../lib/firmTime");
const { jobWhere, isCallCenter } = require("../lib/jobs");
const { CRITERIA, MAX, LABELS } = require("./callReview");

// The Monday coaching message (the user's pick, 2026-10-24): each operator
// gets, from last week's AI call reviews (beta), how they did, what they do
// best and the ONE thing to work on this week — with a line from one of their
// own calls said better. The boss and the developer get the team in a few
// lines. Monday from 9:00, once (telegram/jobs.js); nothing for someone with
// fewer than MIN_REVIEWS reviewed calls last week.

const MIN_REVIEWS = 3;

const avg = (list) => list.reduce((a, b) => a + b, 0) / list.length;

// Reviews (with details) -> { count, score, parts [{ key, label, share }] }.
function summarize(reviews) {
  if (!reviews.length) return null;
  const parts = CRITERIA.map((key) => {
    const shares = reviews.map((r) => (r.details.criteria || []).find((c) => c.key === key)).filter((c) => c && Number.isFinite(c.points)).map((c) => c.points / MAX[key]);
    return { key, label: LABELS[key], share: shares.length ? Math.round(avg(shares) * 100) : null };
  }).filter((p) => p.share !== null);
  return { count: reviews.length, score: Math.round(avg(reviews.map((r) => r.score))), parts: parts.sort((a, b) => b.share - a.share) };
}

// The operator's message (Telegram HTML). Pure: this week's and the week
// before's reviews (newest first), the week's label, a link.
function operatorMessage({ week, before, label, link, f }) {
  const s = summarize(week);
  if (!s || s.count < MIN_REVIEWS) return null;
  const prev = summarize(before);
  const change = prev ? s.score - prev.score : null;
  const best = s.parts.filter((p) => p.share >= 70).slice(0, 2);
  const focus = s.parts[s.parts.length - 1];
  // What was said about that part in the call that scored lowest on it.
  const worstCall = [...week]
    .map((r) => ({ r, c: (r.details.criteria || []).find((c) => c.key === focus.key) }))
    .filter((x) => x.c)
    .sort((a, b) => a.c.points - b.c.points)[0];
  const note = worstCall?.c.note ? String(worstCall.c.note).trim() : null;
  // A better line, from their lowest-scoring call that has one.
  const example = [...week].sort((a, b) => a.score - b.score).flatMap((r) => r.details.betterLines || []).find((b) => b.said && b.better);
  return [
    `🎯 <b>Haftalik maslahat</b> (Beta) — ${label}`,
    `Tahlil qilingan qoʻngʻiroqlar: ${s.count} ta · oʻrtacha <b>${s.score}/100</b>${change == null ? "" : ` (oldingi hafta ${prev.score}${change > 0 ? `, ↑ ${change}` : change < 0 ? `, ↓ ${-change}` : ""})`}`,
    best.length ? `✅ Eng yaxshisi: ${best.map((p) => `${p.label} (${p.share}%)`).join(", ")}` : null,
    `💡 <b>Shu hafta ustida ishlang: ${focus.label}</b> (${focus.share}%)${note ? `\n${f.escapeHtml(note.length > 300 ? `${note.slice(0, 297)}…` : note)}` : ""}`,
    example ? `🗣 «${f.escapeHtml(example.said.slice(0, 200))}» oʻrniga:\n«${f.escapeHtml(example.better.slice(0, 300))}»` : null,
    link,
  ]
    .filter(Boolean)
    .join("\n");
}

// The team for the boss and the developer: one line per operator.
function teamMessage({ rows, label, link, f }) {
  const lines = rows
    .filter((r) => r.week)
    .sort((a, b) => b.week.score - a.week.score)
    .map((r) => {
      const change = r.before ? r.week.score - r.before.score : null;
      const focus = r.week.parts[r.week.parts.length - 1];
      return `• ${f.escapeHtml(r.name)} — ${r.week.score}/100 (${r.week.count} ta)${change ? (change > 0 ? ` ↑${change}` : ` ↓${-change}`) : ""}${focus ? ` · ustida ishlash: ${focus.label}` : ""}`;
    });
  if (!lines.length) return null;
  return [`📊 <b>Operatorlar haftasi</b> (AI baho, Beta) — ${label}`, ...lines, link].join("\n");
}

const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
function weekLabel(from, to) {
  const d = (s) => Number(s.slice(8, 10));
  const m = (s) => MONTHS[Number(s.slice(5, 7)) - 1];
  return from.slice(5, 7) === to.slice(5, 7) ? `${d(from)}–${d(to)}-${m(to)}` : `${d(from)}-${m(from)} – ${d(to)}-${m(to)}`;
}

// Reviews of these operators' calls in [from, to] (firm days): employeeId -> [review], newest first.
async function reviewsBy(ids, from, to) {
  const rows = await prisma.callAnalysis.findMany({
    where: {
      status: "done",
      score: { not: null },
      OR: [{ feedbackCorrect: null }, { feedbackCorrect: true }],
      callLog: { employeeId: { in: ids }, callTimestampMs: { gte: BigInt(firmDayRange(from).from), lte: BigInt(firmDayRange(to).to) } },
    },
    orderBy: { callLog: { callTimestampMs: "desc" } },
    select: { score: true, details: true, callLog: { select: { employeeId: true } } },
  });
  const out = new Map(ids.map((id) => [id, []]));
  for (const r of rows) if (r.details) out.get(r.callLog.employeeId)?.push(r);
  return out;
}

// Monday from 9:00 (`now` = firmNow()): last week's messages, once each.
async function weeklyCoaching(now) {
  if (isoWeekday(now.date) !== 1 || now.minutes < 9 * 60 || now.minutes >= 12 * 60) return 0;
  const { notifyUser, linkedUsers, once } = require("./telegram/notify");
  const { claudeFeatureOn } = require("./ai/settings");
  if (!(await claudeFeatureOn("callReview"))) return 0;
  const f = require("./telegram/format");
  const from = shiftDate(weekStartOf(now.date), -7);
  const to = shiftDate(from, 6);
  const label = weekLabel(from, to);
  const operators = (await prisma.employee.findMany({ where: { active: true, userId: { not: null }, ...jobWhere(["call_center"]) }, select: { id: true, userId: true, name: true, job: true, extraJobs: true } })).filter(isCallCenter);
  if (!operators.length) return 0;
  const ids = operators.map((e) => e.id);
  const [week, before] = await Promise.all([reviewsBy(ids, from, to), reviewsBy(ids, shiftDate(from, -7), shiftDate(to, -7))]);
  let sent = 0;
  const rows = [];
  for (const e of operators) {
    rows.push({ name: e.name, week: summarize(week.get(e.id)), before: summarize(before.get(e.id)) });
    const text = operatorMessage({ week: week.get(e.id), before: before.get(e.id), label, link: f.portalLink(`/performance/${e.id}`, "Bahoni koʻrish"), f });
    if (!text) continue;
    if (await once(`coaching:${e.userId}:${from}`, () => notifyUser(e.userId, "callReviews", text))) sent += 1;
  }
  const team = teamMessage({ rows, label, link: f.portalLink("/performance", "Natijalar"), f });
  if (team) {
    for (const user of await linkedUsers({ role: { in: ["BOSS", "DEVELOPER"] } })) {
      await once(`coaching-team:${user.id}:${from}`, () => notifyUser(user, "aiReports", team));
    }
  }
  return sent;
}

module.exports = { weeklyCoaching, operatorMessage, teamMessage, summarize, weekLabel, MIN_REVIEWS };
