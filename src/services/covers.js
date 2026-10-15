const prisma = require("../lib/prisma");
const cl = require("./clients");
const { firmNow } = require("../lib/firmTime");
const { displayName, LAWYER_NAME } = require("../lib/lawyers");

// A lawyer away and the colleague covering for them (LawyerCover,
// 2026-10-15). While a cover runs (from..to, not ended), the colleague is on
// each of the away lawyer's open cases as an extra lawyer (CaseExtraLawyer
// with coverId): they see and work on them as the lawyer does, and the
// cases' dates show on their own calendar. When it ends, those rows go —
// anything they did on the cases stays. A case the colleague is already on
// is left as it is.
//
// syncCovers runs every 10 minutes (services/scheduler.js) and right after a
// cover is added, changed or ended (routes/covers.js).

const isRunning = (cover, today) => !cover.endedAt && cover.from <= today && today <= cover.to;

// The away lawyer's open cases (as the main lawyer, or an extra one that
// isn't itself a cover).
const awayCasesWhere = (lawyerId) => ({
  status: { in: cl.OPEN_STATUSES },
  OR: [{ lawyerId }, { extraLawyers: { some: { userId: lawyerId, coverId: null } } }],
});

async function syncCovers({ now = firmNow(), db = prisma, notify = true } = {}) {
  const today = now.date;
  const covers = await db.lawyerCover.findMany({
    where: { OR: [{ to: { gte: today }, endedAt: null }, { cases: { some: {} } }] },
    include: { lawyer: { select: LAWYER_NAME }, cover: { select: LAWYER_NAME }, cases: { select: { id: true, caseId: true } } },
  });
  let added = 0;
  let removed = 0;
  for (const cover of covers) {
    if (!isRunning(cover, today)) {
      if (cover.cases.length) {
        removed += (await db.caseExtraLawyer.deleteMany({ where: { coverId: cover.id } })).count;
        if (notify) await tell(cover, "ended");
      }
      continue;
    }
    const cases = await db.clientCase.findMany({
      where: { ...awayCasesWhere(cover.lawyerId), lawyerId: { not: cover.coverId }, extraLawyers: { none: { userId: cover.coverId } } },
      select: { id: true },
    });
    for (const k of cases) {
      try {
        await db.caseExtraLawyer.create({ data: { caseId: k.id, userId: cover.coverId, coverId: cover.id, addedById: cover.createdById } });
        added += 1;
      } catch (err) {
        if (err.code !== "P2002") throw err; // added meanwhile
      }
    }
    if (notify && cover.cases.length === 0 && cases.length > 0) await tell(cover, "started", cases.length);
  }
  return { added, removed };
}

// The colleague hears when a cover starts (and how many cases) and ends.
async function tell(cover, what, count = 0) {
  try {
    const { notifyUser, once } = require("./telegram/notify");
    const f = require("./telegram/format");
    const away = f.escapeHtml(displayName(cover.lawyer));
    const text =
      what === "started"
        ? `🤝 <b>${away} yoʻqligida uning ishlariga siz qaraysiz</b>\n${f.day(cover.from)} — ${f.day(cover.to)} · ${count} ta ish${cover.note ? `\n${f.escapeHtml(cover.note)}` : ""}\nIshlari va sanalari endi sizning roʻyxatingiz va kalendaringizda.`
        : `🤝 ${away} oʻrniga qarash tugadi — uning ishlari roʻyxatingizdan olindi.`;
    await once(`cover-${what}:${cover.id}`, () => notifyUser(cover.coverId, "cases", text));
  } catch (err) {
    console.error("[covers] notify failed:", err.message);
  }
}

module.exports = { syncCovers, isRunning, awayCasesWhere };
