const prisma = require("../lib/prisma");
const cl = require("./clients");
const { firmNow, shiftDate } = require("../lib/firmTime");
const { lawyerCaseWhere } = require("../lib/clientAccess");
const { isManager, isLawyer } = require("../middleware/auth");
const { isCoordinator } = require("../lib/jobs");

// The dates in a case that take place — hearings, questionings, summons —
// and what came of them (2026-10-15). Once one has passed without an
// outcome, Ledger asks its lawyers "how did it go?" (the case page, their
// home, and an evening message); one answer writes the outcome, the history
// entry and the next date, and tells the team (routes/caseWork.js).
// Reminders: the evening before and the morning of each one.

const OUTCOME_KINDS = ["hearing", ...cl.INVESTIGATION_KINDS, "summons"];
// Reminded about the evening before and on the morning: these and deadlines.
const REMINDED_KINDS = [...OUTCOME_KINDS, "deadline"];
const LOOKBACK_DAYS = 30;

const KIND_WORDS = {
  hearing: "Sud majlisi",
  investigative_action: "Tergov harakati",
  interrogation: "Soʻroq",
  confrontation: "Yuzlashtirish",
  suspect_questioning: "Gumonlanuvchi sifatida soʻroq",
  accused_questioning: "Ayblanuvchi sifatida soʻroq",
  charge_announced: "Ayb eʼlon qilish",
  case_review: "Ish bilan tanishish",
  summons: "Chaqiruv",
  deadline: "Muddat",
};
const RESULT_WORDS = { postponed: "Keyinga qoldirildi", heard: "Koʻrib chiqildi", decided: "Qaror chiqarildi", not_held: "Boʻlmadi", other: "" };

// Has it taken place (firm time)? A whole-day one counts from 17:00; a timed
// one half an hour after it starts.
function hasPassed(row, now) {
  if (row.date < now.date) return true;
  if (row.date > now.date) return false;
  return now.minutes >= (row.time == null ? 17 * 60 : row.time + 30);
}

// Whose cases' outcomes someone is asked about: managers every case, a
// lawyer theirs, a coordinator the ones they look after.
function dueScope(user) {
  if (isManager(user)) return {};
  if (isLawyer(user)) return lawyerCaseWhere(user.id);
  if (isCoordinator(user.employee)) return { coordinatorId: user.employee.id };
  return null;
}

const DUE_CASE = { select: { id: true, matter: true, number: true, clientId: true, lawyer: true, lawyerId: true, client: { select: { name: true } } } };

async function listDue(user, { now = firmNow(), db = prisma } = {}) {
  const scope = dueScope(user);
  if (!scope) return [];
  const rows = await db.caseDate.findMany({
    where: {
      deletedAt: null,
      outcome: null,
      kind: { in: OUTCOME_KINDS },
      date: { gte: shiftDate(now.date, -LOOKBACK_DAYS), lte: now.date },
      case: { ...scope, status: { not: "declined" }, client: { archivedAt: null } },
    },
    orderBy: [{ date: "desc" }, { time: "desc" }],
    take: 100,
    include: { case: DUE_CASE },
  });
  return rows.filter((r) => hasPassed(r, now));
}

// The team's line about it (the case's discussion): "Sud majlisi (15-okt):
// Keyinga qoldirildi. … Keyingi: 20-okt, 10:00".
function outcomeLine(row, { result, text, next }, f = require("./telegram/format")) {
  const what = KIND_WORDS[row.kind] || "Sana";
  const head = `⚖️ ${what} (${f.day(row.date)}${row.time != null ? `, ${f.clock(row.time)}` : ""})`;
  const words = [RESULT_WORDS[result], text && text !== RESULT_WORDS[result] ? text : null].filter(Boolean).join(". ");
  const lines = [words ? `${head}: ${words}` : head];
  if (next) lines.push(`Keyingi: ${f.day(next.date)}${next.time != null ? `, ${f.clock(next.time)}` : ""}${next.place ? ` · ${next.place}` : ""}`);
  return lines.join("\n");
}

// Who hears about a case's date: its lawyers (main and extra) and its
// coordinator — user ids.
async function peopleOf(caseId, db = prisma) {
  const k = await db.clientCase.findUnique({
    where: { id: caseId },
    select: { lawyerId: true, extraLawyers: { select: { userId: true } }, coordinator: { select: { userId: true } } },
  });
  if (!k) return [];
  return [...new Set([k.lawyerId, ...k.extraLawyers.map((x) => x.userId), k.coordinator?.userId].filter(Boolean))];
}

// Every minute (services/telegram/jobs.js):
//   18:00–21:00  tomorrow's dates -> their people ("ertaga")
//   07:30–10:00  today's -> their people ("bugun")
//   18:30–21:00  today's that took place with no outcome yet -> their lawyers
async function hearingReminders(now = firmNow(), db = prisma) {
  const { notifyUser, once } = require("./telegram/notify");
  const f = require("./telegram/format");
  const at = (h, m = 0) => h * 60 + m;
  const line = (r) =>
    [
      `<b>${f.escapeHtml(KIND_WORDS[r.kind] || "Muhim sana")}</b>${r.time != null ? ` — ${f.clock(r.time)}` : ""}`,
      [r.title, r.place].filter(Boolean).map(f.escapeHtml).join(" · "),
      `${f.escapeHtml(r.case.client.name)}${r.case.matter ? ` · ${f.escapeHtml(r.case.matter)}` : ""}`,
    ]
      .filter(Boolean)
      .join("\n");
  const rowsOn = (date) =>
    db.caseDate.findMany({
      where: { deletedAt: null, date, kind: { in: REMINDED_KINDS }, case: { status: { not: "declined" }, client: { archivedAt: null } } },
      include: { case: DUE_CASE },
    });

  if (now.minutes >= at(18) && now.minutes < at(21)) {
    for (const r of await rowsOn(shiftDate(now.date, 1))) {
      for (const userId of await peopleOf(r.caseId, db)) {
        await once(`hearing-eve:${r.id}:${r.date}:${userId}`, () =>
          notifyUser(userId, "hearings", [`🗓 Ertaga`, line(r), f.portalLink(`/clients/${r.case.clientId}?case=${r.caseId}&section=dates`, "Ishni ochish")].join("\n"))
        );
      }
    }
  }
  if (now.minutes >= at(7, 30) && now.minutes < at(10)) {
    for (const r of await rowsOn(now.date)) {
      for (const userId of await peopleOf(r.caseId, db)) {
        await once(`hearing-day:${r.id}:${r.date}:${userId}`, () =>
          notifyUser(userId, "hearings", [`🗓 Bugun`, line(r), f.portalLink(`/clients/${r.case.clientId}?case=${r.caseId}&section=dates`, "Ishni ochish")].join("\n"))
        );
      }
    }
  }
  if (now.minutes >= at(18, 30) && now.minutes < at(21)) {
    const rows = (await rowsOn(now.date)).filter((r) => OUTCOME_KINDS.includes(r.kind) && r.outcome == null && hasPassed(r, now));
    for (const r of rows) {
      const k = await db.clientCase.findUnique({ where: { id: r.caseId }, select: { lawyerId: true, extraLawyers: { select: { userId: true } } } });
      const lawyers = [...new Set([k?.lawyerId, ...(k?.extraLawyers || []).map((x) => x.userId)].filter(Boolean))];
      for (const userId of lawyers) {
        await once(`hearing-outcome:${r.id}:${userId}`, () =>
          notifyUser(userId, "hearings", [`✍️ <b>Natijasi yozilmagan</b>`, line(r), "Qanday oʻtdi? Natija va keyingi sana — bir joyda.", f.portalLink(`/clients/${r.case.clientId}?case=${r.caseId}`, "Natijani yozish")].join("\n"))
        );
      }
    }
  }
}

module.exports = { OUTCOME_KINDS, REMINDED_KINDS, KIND_WORDS, RESULT_WORDS, hasPassed, dueScope, listDue, outcomeLine, peopleOf, hearingReminders };
