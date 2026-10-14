const crypto = require("crypto");
const prisma = require("../../lib/prisma");
const { canSeeFinance } = require("../../lib/finance");
const { firmNow, shiftDate, isoWeekday } = require("../../lib/firmTime");
const { events } = require("../../lib/events");
const { aiSettings, claudeFeatureOn } = require("./settings");
const claude = require("./claude");
const insights = require("./insights");

// What Claude writes on a clock (2026-10-14), for the boss and the developer:
//
//   weeklyReport   Monday 8:00 — one page: what changed last week and why,
//                  each person's trend, the clients who need attention, money
//                  risks (with Moliya), three things to do this week
//   lostAnalysis   the 1st of the month — why consultations didn't continue,
//                  the patterns, what to change
//   suggestions    with the weekly report — concrete next steps about
//                  clients, each for the person who works on that client
//                  (AiSuggestion; their home page shows them)
//
// Reports go into each manager's Ledger AI chat and out as a notification
// (Telegram kind "aiReports"). Each one is switched on in Sozlamalar → Sunʼiy
// intellekt; "Hozir tayyorlash" there runs one now. Data is gathered with the
// same lookups as the chat (insights.js, tools.js), as the person reading it
// may see it — contract money only for those with Moliya.

const MANAGER_ROLES = ["BOSS", "DEVELOPER"];

function scriptRule(script) {
  return script === "cyrillic"
    ? "Javobni oʻzbek tilida, KIRILL yozuvida yozing (масалан: «Ўтган ҳафта…»)."
    : "Javobni oʻzbek tilida, LOTIN yozuvida yozing (oʻ, gʻ bilan).";
}

// The managers who get reports, in groups that see the same data (with
// Moliya, without) — one report per group, not one per person.
async function readers() {
  const users = await prisma.user.findMany({ where: { active: true, role: { in: MANAGER_ROLES } }, include: { employee: true } });
  const groups = new Map();
  for (const u of users) {
    const key = canSeeFinance(u) ? "money" : "plain";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(u);
  }
  return [...groups.values()];
}

// "**bold**" -> Telegram HTML, everything else escaped.
function telegramHtml(text) {
  const f = require("../telegram/format");
  return f.escapeHtml(text).replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
}

// Into the person's Ledger AI chat, and a notification with the start of it.
async function deliver(user, title, text) {
  const chat = require("../chat");
  const conv = await chat.ensureAssistant(user);
  const body = `${title}\n\n${text}`.slice(0, 4000);
  const message = await prisma.message.create({ data: { conversationId: conv.id, authorId: null, text: body } });
  await prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: message.createdAt } });
  require("../live").bump([user.id]);
  const { notifyUser } = require("../telegram/notify");
  const f = require("../telegram/format");
  const preview = text.length > 3300 ? `${text.slice(0, 3290)}…` : text;
  await notifyUser(user.id, "aiReports", [`<b>${f.escapeHtml(title)}</b>`, telegramHtml(preview), f.portalLink(`/chat/${conv.id}`, "Ledger AI da ochish")].join("\n\n")).catch(() => {});
}

async function write({ feature, system, data, effort = "high" }) {
  const response = await claude.create(
    {
      system,
      messages: [{ role: "user", content: `Maʼlumotlar (JSON):\n${JSON.stringify(data)}` }],
      output_config: { effort },
    },
    { feature }
  );
  if (response.stop_reason === "refusal") return null;
  return claude.textOf(response) || null;
}

const COMMON_RULES = [
  "- Faqat berilgan maʼlumotlardan foydalaning. Raqam yoki ismni oʻylab topmang; maʼlumot yetmasa — shuni ayting.",
  "- Qisqa va aniq: har bir fikr alohida qatorda, raqamlar bilan. Markdown jadval va sarlavha (#) ishlatmang; muhim soʻzni **qalin** qilish mumkin.",
  "- Mijozni ismi bilan ayting. Xodimni ismi bilan ayting — ayblovchi emas, holatni koʻrsatuvchi ohangda.",
];

// ------------------------------------------------------------- weekly
async function weeklyReport({ force = false } = {}) {
  if (!force && !(await claudeFeatureOn("weeklyReport"))) return { skipped: "off" };
  const settings = await aiSettings();
  const tools = require("./tools");
  const today = firmNow().date;
  const results = [];
  for (const group of await readers()) {
    const viewer = group[0];
    const [trends, radar, funnel, staff] = await Promise.all([
      insights.trends(viewer, { weeks: 8 }),
      insights.clientRadar(viewer, { limit: 12 }),
      tools.run("call_funnel", { from: shiftDate(today, -7), to: shiftDate(today, -1) }, viewer),
      tools.run("staff_performance", {}, viewer),
    ]);
    const s = require("../consultSummary");
    const missingSummaries = await prisma.appointment.count({ where: s.missingWhere(await s.summaryRule(), firmNow()) });
    const system = [
      "Siz «Ledger AI» — yuridik firmaning ichki tizimidagi tahlilchisiz. Firma rahbari uchun HAFTALIK HISOBOT yozasiz: u dushanba ertalab telefonda oʻqiydi.",
      `Bugun: ${today}. «Oʻtgan hafta» — oxirgi tugagan dushanba–yakshanba; uni oldingi haftalar bilan solishtiring.`,
      "Tuzilishi (shu tartibda, har biri qisqa):",
      "1. **Asosiy xulosa** — 2–3 qator: hafta qanday oʻtdi, eng muhim oʻzgarish.",
      "2. **Nima oʻzgardi** — qoʻngʻiroqlar, konsultatsiyalar, shartnomalar, yoʻqotilganlar: oʻtgan hafta va oldingi 4 haftaning oʻrtachasi bilan, raqamlarda; sababini maʼlumotdan topa olsangiz — ayting.",
      "3. **Xodimlar** — kim yaxshilandi, kim pasaydi (haftalar boʻyicha raqamlar bilan), kim eʼtibor talab qiladi.",
      "4. **Eʼtibor talab qiladigan mijozlar** — eng muhim 5 tasi, har biri: ism — nima uchun — kim qilishi kerak.",
      ...(canSeeFinance(viewer) ? ["5. **Pul** — muddati oʻtgan toʻlovlar va xavf (agar boʻlsa)."] : []),
      `${canSeeFinance(viewer) ? 6 : 5}. **Bu hafta qilinadigan 3 ish** — aniq, bajarsa boʻladigan.`,
      "Hammasi 350 soʻzdan oshmasin.",
      // Calls (src/lib/calling.js): only the call center's and coordinators'
      // phones, from their phones' call logs — no firm line yet.
      "Qoʻngʻiroqlar haqida: raqamlar faqat call-markaz va koordinatorlarniki (boshqalarning qoʻngʻiroqlari hisoblanmaydi). Ular xodimlarning telefonidagi qoʻngʻiroqlar roʻyxatidan olinadi, shuning uchun taxminiy — firma telefon liniyasi (IP-telefoniya) ulanguncha. Qoʻngʻiroq raqamlariga ortiqcha urgʻu bermang va ular asosida keskin xulosa qilmang; asosiy eʼtibor konsultatsiya, shartnoma va mijozlarda boʻlsin. Hisobotda bu haqda bir marta, qisqa eslatib oʻting.",
      ...COMMON_RULES,
      scriptRule(settings.reportScript),
    ].join("\n");
    const text = await write({ feature: "weeklyReport", system, data: { today, trends, callFunnelLastWeek: funnel, thisMonthByPerson: staff, clientsNeedingAttention: radar, consultationSummariesNotWritten: missingSummaries } });
    if (!text) continue;
    for (const user of group) await deliver(user, `📊 Haftalik hisobot — ${today}`, text);
    results.push({ readers: group.map((u) => u.username), chars: text.length });
  }
  return { done: true, reports: results };
}

// ------------------------------------------------------------- monthly: lost clients
async function lostAnalysis({ force = false } = {}) {
  if (!force && !(await claudeFeatureOn("lostAnalysis"))) return { skipped: "off" };
  const settings = await aiSettings();
  const today = firmNow().date;
  const results = [];
  for (const group of await readers()) {
    const viewer = group[0];
    const [lost, trends] = await Promise.all([insights.lostReasons(viewer, { from: shiftDate(today, -90), to: today }), insights.trends(viewer, { weeks: 13 })]);
    const system = [
      "Siz «Ledger AI» — yuridik firmaning ichki tizimidagi tahlilchisiz. Firma rahbari uchun OYLIK TAHLIL yozasiz: konsultatsiyaga kelgan mijozlar nega shartnoma tuzmayapti.",
      `Bugun: ${today}. Davr — oxirgi 90 kun.`,
      "Tuzilishi:",
      "1. **Asosiy xulosa** — 2–3 qator: nechta yoʻqotildi, nechta shartnoma, asosiy sabab.",
      "2. **Sabablar** — har bir sabab ulushi bilan; qaysi masalalarda (ish turlarida) koʻp yoʻqotilyapti.",
      "3. **Qonuniyatlar** — izohlar va advokatlar yozgan yakunlardan koʻringan takrorlanuvchi holatlar (masalan, narx, ishonch, kech qoʻngʻiroq).",
      "4. **Xodimlar boʻyicha** — kimda koʻp yoʻqotilmoqda, faqat raqam bilan, ayblamasdan.",
      "5. **Nimani oʻzgartirish kerak** — 3–5 ta aniq taklif (qoʻngʻiroq matni, narx tushuntirish, qayta aloqa vaqti va hokazo).",
      "Hammasi 400 soʻzdan oshmasin. Maʼlumot kam boʻlsa — xulosa ham qisqa boʻlsin va buni ayting.",
      ...COMMON_RULES,
      scriptRule(settings.reportScript),
    ].join("\n");
    const text = await write({ feature: "lostAnalysis", system, data: { today, lost, weeklyTrends: trends.weeks } });
    if (!text) continue;
    for (const user of group) await deliver(user, `🔎 Oylik tahlil: nega mijozlar ketmoqda — ${today}`, text);
    results.push({ readers: group.map((u) => u.username), chars: text.length });
  }
  return { done: true, reports: results };
}

// ------------------------------------------------------------- suggestions
const KINDS = ["call", "follow_up", "money", "case", "data", "other"];
const FOR = ["operator", "coordinator", "lawyer", "managers"];
const SUGGESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["suggestions"],
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["clientId", "kind", "priority", "text", "why", "for"],
        properties: {
          clientId: { anyOf: [{ type: "integer" }, { type: "null" }] },
          kind: { type: "string", enum: KINDS },
          priority: { type: "integer", enum: [1, 2, 3] },
          text: { type: "string" },
          why: { type: "string" },
          for: { type: "string", enum: FOR },
        },
      },
    },
  },
};

// Who works on each of these clients now (their latest open case).
async function responsibleFor(clientIds) {
  const cases = await prisma.clientCase.findMany({
    where: { clientId: { in: clientIds }, status: { in: ["consultation", "call_again", "contract"] } },
    orderBy: { updatedAt: "desc" },
    select: { clientId: true, lawyerId: true, operator: { select: { userId: true } }, coordinator: { select: { userId: true } } },
  });
  const map = new Map();
  for (const k of cases) {
    if (map.has(k.clientId)) continue;
    map.set(k.clientId, { operator: k.operator?.userId ?? null, coordinator: k.coordinator?.userId ?? null, lawyer: k.lawyerId ?? null });
  }
  return map;
}

async function suggestions({ force = false } = {}) {
  if (!force && !(await claudeFeatureOn("suggestions"))) return { skipped: "off" };
  const settings = await aiSettings();
  // The whole firm's view, money included (each suggestion then goes to the
  // person on that client — a money one to the coordinator, who sees it).
  const firm = { role: "DEVELOPER", active: true };
  const radar = await insights.clientRadar(firm, { limit: 30 });
  const ids = [...new Set(Object.values(radar).flat().map((r) => r.clientId).filter(Boolean))];
  if (ids.length === 0) return { done: true, created: 0 };
  const system = [
    "Siz «Ledger AI» — yuridik firmaning ichki tizimidagi yordamchisiz. Quyidagi roʻyxatlar — hozir eʼtibor talab qiladigan mijozlar.",
    "Har biri uchun bitta aniq, bajarsa boʻladigan TAVSIYA yozing (eng muhim 25 tadan oshmasin):",
    "- text: nima qilish kerak, buyruq ohangida, 1 jumla (masalan: «Karimov Jasurga qoʻngʻiroq qiling — qarorini soʻrang, 5 kun kechikdi»).",
    "- why: nega — maʼlumotdan 1 qisqa jumla.",
    "- for: kim qiladi — operator (konsultatsiya bosqichi), coordinator (shartnomadan keyin, pul), lawyer (ish boʻyicha), managers (boshqa hollarda).",
    "- priority: 1 — bugun, 2 — shu hafta, 3 — kutsa boʻladi.",
    "- clientId: roʻyxatdagi mijoz id si (boshqa raqam yozmang).",
    ...COMMON_RULES,
    scriptRule(settings.reportScript),
  ].join("\n");
  const response = await claude.create(
    { system, messages: [{ role: "user", content: `Maʼlumotlar (JSON):\n${JSON.stringify({ today: firmNow().date, radar })}` }], output_config: { effort: "medium", format: { type: "json_schema", schema: SUGGESTION_SCHEMA } } },
    { feature: "suggestions" }
  );
  const out = claude.jsonOf(response);
  if (!out) return { done: false, reason: response.stop_reason };
  const known = new Set(ids);
  const people = await responsibleFor(ids);
  const runId = crypto.randomUUID();
  const rows = out.suggestions
    .filter((x) => x.text && (x.clientId == null || known.has(x.clientId)))
    .slice(0, 25)
    .map((x) => {
      const who = x.clientId != null ? people.get(x.clientId) : null;
      const forUserId = x.for === "managers" || !who ? null : who[x.for] ?? who.operator ?? null;
      return { clientId: x.clientId, forUserId, kind: KINDS.includes(x.kind) ? x.kind : "other", priority: [1, 2, 3].includes(x.priority) ? x.priority : 2, text: x.text.slice(0, 400), why: x.why?.slice(0, 400) || null, runId };
    });
  await prisma.$transaction(async (tx) => {
    // The new run replaces what's still open from earlier ones.
    await tx.aiSuggestion.updateMany({ where: { doneAt: null, dismissedAt: null, runId: { not: runId } }, data: { dismissedAt: new Date() } });
    if (rows.length) await tx.aiSuggestion.createMany({ data: rows });
  });
  events.emit("ai.suggestions", { runId });
  return { done: true, created: rows.length };
}

// ------------------------------------------------------------- on the clock
// Every few minutes (services/scheduler.js): Monday 8:00–11:00 the weekly
// report and the suggestions, the 1st of the month 9:00–12:00 the lost-client
// analysis. Each once (a restart doesn't send it twice).
async function tick() {
  const { once } = require("../telegram/notify");
  const now = firmNow();
  if (isoWeekday(now.date) === 1 && now.minutes >= 8 * 60 && now.minutes < 11 * 60) {
    if (await claudeFeatureOn("weeklyReport")) await once(`ai-weekly:${now.date}`, () => weeklyReport());
    if (await claudeFeatureOn("suggestions")) await once(`ai-suggestions:${now.date}`, () => suggestions());
  }
  if (now.date.endsWith("-01") && now.minutes >= 9 * 60 && now.minutes < 12 * 60 && (await claudeFeatureOn("lostAnalysis"))) {
    await once(`ai-lost:${now.date.slice(0, 7)}`, () => lostAnalysis());
  }
}

module.exports = { weeklyReport, lostAnalysis, suggestions, tick, telegramHtml, SUGGESTION_SCHEMA };
