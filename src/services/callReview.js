const prisma = require("../lib/prisma");
const { getSetting } = require("../lib/settings");
const { claudeFeatureOn } = require("./ai/settings");
const { isCallCenter } = require("../lib/jobs");

// The AI review of operators' calls (BETA, 2026-10-24, the user's ask): once
// a call on Ledger's line has been turned into text on the server
// (pbx/transcriber → /pbx/transcribe/done), Claude reads it and coaches the
// operator against the firm's call standard («Qoʻngʻiroq standarti», 2-versiya;
// call-center/qongiroq-standarti): points for each of its nine criteria, what
// was good, what to improve, and "you said … — better: …". It judges the
// operator's skill only — it doesn't decide the client's next step. The
// operator is told when it's ready; a manager can mark it right or wrong,
// and the latest corrections go back to the AI as the firm's own examples.
// Claude Haiku (cheap), on the firm's Claude key, its monthly cap and the
// "callReview" switch.

// The standard in short — what the AI scores. Editable later in a setting
// ("callReview".rules); this is the default.
const DEFAULT_RULES = [
  "Firma: «Mir Said Baraka Himoya» advokatlik firmasi. Konsultatsiyani firma rahbari, advokat shaxsan oʻtkazadi: ofisda — 600 000 soʻm, videoaloqa orqali — 450 000 soʻm, toʻlov oldindan. Firma mehnat nizolarini olmaydi. Operator yuridik masalani oʻzi hal qilmaydi: maqsad — mijozni eshitish, tushunish va konsultatsiyaga yozish.",
  "Mezonlar (jami 100 ball):",
  "1. Salomlashish (10): firma nomi, oʻz ismi, mijozning ismini soʻradi va keyin ismi bilan murojaat qildi.",
  "2. Yoʻnaltirish (5): yangi yoki firma bilan ishlayotgan mijozligini aniqladi; ishlayotgan boʻlsa — koordinatoriga uladi, ish haqida oʻzi maʼlumot bermadi.",
  "3. Tinglash (15): mijozni boʻlmadi, mijoz koʻp gapirdi; takrorladi, his-tuygʻuni nomladi («Bu sizni juda xavotirga solgan koʻrinadi»).",
  "4. Aniqlovchi savollar (15): qachon boshlandi, qanday hujjatlar bor, yaqin sana (sud, tergov, muddat) bormi, avval biror chora koʻrdimi, qanday natija kutadi, qarorni yana kim qiladi — bittadan.",
  "5. Xulosa (10): vaziyatni mijozning soʻzlari bilan qaytardi va «Toʻgʻri tushundimmi?» deb tasdiqlatdi.",
  "6. Taklif (10): mijozning vaziyati → advokat nima qiladi (hujjatlarni oʻrganadi, yoʻllar va xavflarni aytadi, reja beradi) → mijoz nima oladi. Muammoni bilmay turib yozishga shoshilmadi.",
  "7. Narx va vaqt (15): narxni ishonch bilan, uzr soʻramasdan aytdi va darhol ikki aniq vaqt taklif qildi («ertaga 11:00 yoki payshanba 16:00»), «qachon qulay?» deb soʻramadi.",
  "8. Yakun (10): yozilgan boʻlsa — toʻlov, hujjatlar, eslatma; «yana savolingiz bormi?», rahmat; har holda aniq keyingi qadam (yozilish yoki kelishilgan qayta aloqa).",
  "9. Ovoz va odob (10): iliq ohang, «siz», ism bilan murojaat, ijobiy soʻzlar («Bilmadim» emas — «Aniqlab aytaman»), toʻldiruvchi soʻzlar («ee», «xoʻsh») kam.",
  "Qoʻpol xato — har biri −20 ball: yuridik maslahat yoki xulosa berdi; natija vaʼda qildi yoki foizda imkoniyat aytdi; oʻylab topilgan chegirma yoki muddat ishlatdi; mijozga qoʻpollik qildi; ishlayotgan mijozga uning ishi haqida maʼlumot berdi.",
  "Eʼtirozlar (qimmat, oʻylab koʻraman, oilam bilan maslahatlashaman, vaqtim yoʻq…): tan olish → asl sababni aniqlash → qiymatni koʻrsatish → tanlov bilan savol; bir eʼtirozga ikki martadan ortiq urinmaslik, bosim oʻtkazmaslik.",
  "Mijoz qaysi tilda gapirsa, operator oʻsha tilda gapiradi.",
].join("\n");

const MODELS = ["claude-haiku-5-5"];
const CRITERIA = ["greeting", "routing", "listening", "questions", "summary", "offer", "priceTime", "closing", "manner"];
const MAX = { greeting: 10, routing: 5, listening: 15, questions: 15, summary: 10, offer: 10, priceTime: 15, closing: 10, manner: 10 };
const LABELS = {
  greeting: "Salomlashish",
  routing: "Yoʻnaltirish",
  listening: "Tinglash",
  questions: "Aniqlovchi savollar",
  summary: "Xulosa",
  offer: "Taklif",
  priceTime: "Narx va vaqt",
  closing: "Yakun",
  manner: "Ovoz va odob",
};
const KINDS = ["lead", "existing", "not_relevant"];
const OUTCOMES = ["booked", "not_booked", "existing", "not_client"];
// Calls shorter than this aren't reviewed (a wrong number, "call me later").
const MIN_TALK_SEC = 20;
const LESSONS = 10;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "topic", "outcome", "about", "criteria", "grossErrors", "good", "improve", "betterLines"],
  properties: {
    kind: {
      type: "string",
      enum: KINDS,
      description: "lead = a new person asking for legal help; existing = someone the firm already works with (asking about their case, sending documents); not_relevant = a wrong number, an ad, a job seeker, a personal call",
    },
    topic: { type: "string", description: "The legal area in a few Uzbek words («Jinoyat — chaqiruv», «Oila — ajrashish»), or what the call was if not relevant" },
    outcome: { type: "string", enum: OUTCOMES, description: "booked = the client was booked for a consultation in this call; not_booked = a lead that wasn't booked; existing / not_client as the kind" },
    about: { type: "string", description: "One Uzbek sentence: what the caller wanted. No advice, no next step" },
    criteria: {
      type: "array",
      minItems: 9,
      maxItems: 9,
      description: "The nine criteria, in order, each with the points earned (0..max) and a short Uzbek note on why",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "points", "note"],
        properties: { key: { type: "string", enum: CRITERIA }, points: { type: "integer", minimum: 0, maximum: 15 }, note: { type: "string" } },
      },
    },
    grossErrors: { type: "array", items: { type: "string" }, maxItems: 5, description: "Each gross error from the rules that really happened, in a few Uzbek words (−20 each). Empty when none" },
    good: { type: "array", items: { type: "string" }, maxItems: 3, description: "What the operator did well (Uzbek)" },
    improve: { type: "array", items: { type: "string" }, maxItems: 3, description: "The most important things to do better next time (Uzbek) — only real gaps" },
    betterLines: {
      type: "array",
      maxItems: 3,
      description: "Key moments: what the operator actually said, and a clearly better line per the standard. Only where it matters",
      items: { type: "object", additionalProperties: false, required: ["said", "better"], properties: { said: { type: "string" }, better: { type: "string" } } },
    },
  },
};

const SYSTEM = (rules, lessons) => `You review a law firm call-center operator's phone call, the way a demanding but kind head of customer service coaches a junior — the bar is high, so the operator grows.

The firm's call standard for operators:
${rules}

The call is a transcript made automatically from the recording (Uzbek speech recognition): lines marked "Operator" are the firm's operator, "Mijoz" the caller; a recording that couldn't be split is marked "Suhbat". Recognition makes mistakes — misheard words, missing words — so judge the meaning, never spelling, and don't blame the operator for what may be a recognition error. Tone of voice isn't in a transcript: judge manner by the words.

Decide the kind of call first:
- lead: a new person with a legal question — judge all nine criteria by the standard.
- existing: someone the firm already works with — they aren't sold to: give full points for criteria that don't apply (listening and questions still count as relevant to helping them; "routing" is whether the operator connected them to their coordinator instead of discussing the case).
- not_relevant: a wrong number, an ad, a personal call — full points for criteria that don't apply; judge only greeting and manner.
Give each criterion's points honestly (0 up to its maximum: greeting 10, routing 5, listening 15, questions 15, summary 10, offer 10, priceTime 15, closing 10, manner 10). List gross errors only if they really happened.
Advice only where it's earned: "improve" and "betterLines" are for real gaps; never suggest a line that isn't clearly better than what was said. Quote "said" from the transcript.
Don't decide what should happen with the client next, and don't give legal opinions yourself.${lessons ? `

The firm checked earlier reviews and corrected these — learn from them and judge alike:
${lessons}` : ""}

Write every text in Uzbek (Latin script, with oʻ and gʻ), short and plain, speaking to the operator as "siz".

Record the review with the review tool.`;

async function reviewSettings() {
  const s = await getSetting("callReview", {});
  const rules = String(s.rules || "").trim();
  return { rules: rules || DEFAULT_RULES, customRules: Boolean(rules), model: MODELS.includes(s.model) ? s.model : MODELS[0] };
}

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const WHO = { staff: "Operator", client: "Mijoz", mix: "Suhbat" };

// The transcript as the AI (and the portal) reads it, one line per turn.
function transcriptText(segments) {
  return (segments || []).map((s) => `[${clock(Number(s.start) || 0)}] ${WHO[s.who] || "Suhbat"}: ${String(s.text || "").trim()}`).join("\n");
}

// The AI's answer, made safe: the nine criteria in order, points within
// each maximum, the total 0..100 after gross errors.
function clean(r) {
  const byKey = new Map((Array.isArray(r?.criteria) ? r.criteria : []).map((c) => [c.key, c]));
  const criteria = CRITERIA.map((key) => {
    const c = byKey.get(key) || {};
    return { key, points: Math.max(0, Math.min(MAX[key], Math.round(Number(c.points) || 0))), max: MAX[key], note: String(c.note || "").slice(0, 400) };
  });
  const list = (v, n) => (Array.isArray(v) ? v : []).map((x) => String(x || "").trim()).filter(Boolean).slice(0, n);
  const grossErrors = list(r?.grossErrors, 5);
  const sum = criteria.reduce((s, c) => s + c.points, 0);
  return {
    kind: KINDS.includes(r?.kind) ? r.kind : "lead",
    topic: String(r?.topic || "").slice(0, 120),
    outcome: OUTCOMES.includes(r?.outcome) ? r.outcome : "not_booked",
    about: String(r?.about || "").slice(0, 400),
    criteria,
    grossErrors,
    good: list(r?.good, 3),
    improve: list(r?.improve, 3),
    betterLines: (Array.isArray(r?.betterLines) ? r.betterLines : [])
      .map((b) => ({ said: String(b?.said || "").trim().slice(0, 400), better: String(b?.better || "").trim().slice(0, 400) }))
      .filter((b) => b.said && b.better)
      .slice(0, 3),
    score: Math.max(0, Math.min(100, sum - 20 * grossErrors.length)),
  };
}

// The latest corrections by managers, for the AI to learn from.
async function lessons(db = prisma) {
  const rows = await db.callAnalysis.findMany({
    where: { feedbackCorrect: { not: null }, feedbackNote: { not: null } },
    orderBy: { feedbackAt: "desc" },
    take: LESSONS,
    select: { feedbackCorrect: true, feedbackNote: true, score: true, details: true },
  });
  return rows
    .map((r) => `- ${r.details?.topic || "Qoʻngʻiroq"}: AI ${r.score}/100 bergan — rahbar: ${r.feedbackCorrect ? "toʻgʻri" : "notoʻgʻri"}. ${r.feedbackNote}`)
    .join("\n");
}

// Whether a call is one to review: answered, long enough, an operator's
// (the call center) — and it has a transcript.
function reviewable(call) {
  return Boolean(call && !call.missed && call.durationSeconds >= MIN_TALK_SEC && call.employee && isCallCenter(call.employee));
}

// Reviews one call now. -> the CallAnalysis row, or null.
async function reviewCall(callLogId) {
  if (!(await claudeFeatureOn("callReview"))) return null;
  const claude = require("./ai/claude");
  const call = await prisma.callLog.findUnique({ where: { id: callLogId }, include: { employee: true, transcript: true } });
  if (!reviewable(call) || call.transcript?.status !== "done") return null;
  const segments = Array.isArray(call.transcript.segments) ? call.transcript.segments : [];
  if (!segments.length) return null;
  const { rules, model } = await reviewSettings();
  await prisma.callAnalysis.upsert({ where: { callLogId }, create: { callLogId, status: "processing" }, update: { status: "processing", errorMessage: null } });
  try {
    const response = await claude.create(
      {
        model,
        max_tokens: 3000,
        system: SYSTEM(rules, await lessons()),
        messages: [
          {
            role: "user",
            content: `Qoʻngʻiroq: ${call.callType === "outgoing" ? "operator qoʻngʻiroq qildi" : "mijoz qoʻngʻiroq qildi"}, ${clock(call.durationSeconds)}. Operator: ${call.employee.name}.\n\n${transcriptText(segments)}`,
          },
        ],
        tools: [{ name: "review", description: "Record the review of this call.", input_schema: SCHEMA }],
        tool_choice: { type: "tool", name: "review" },
      },
      { feature: "callReview" }
    );
    const used = (response.content || []).find((b) => b.type === "tool_use");
    if (!used?.input) throw new Error("no review in the answer");
    const r = clean(used.input);
    const { score, about, ...details } = r;
    const row = await prisma.callAnalysis.update({
      where: { callLogId },
      data: { status: "done", score, summary: about, details, model: response.model || model, costUsd: claude.costOf(response.model || model, response.usage) },
    });
    await tellOperator(call, row).catch((err) => console.error("[call-review] telling the operator failed:", err.message));
    return row;
  } catch (err) {
    await prisma.callAnalysis.update({ where: { callLogId }, data: { status: "failed", errorMessage: String(err.message || err).slice(0, 300) } });
    throw err;
  }
}

// "Your call was reviewed" — Telegram and the app, once.
async function tellOperator(call, analysis) {
  if (analysis.notifiedAt) return;
  const user = await prisma.user.findFirst({ where: { employee: { id: call.employeeId } } });
  if (!user) return;
  const f = require("./telegram/format");
  const { notifyUser } = require("./telegram/notify");
  const d = analysis.details || {};
  const lines = [
    `📞 <b>Qoʻngʻiroqingiz tahlil qilindi</b> (Beta) — <b>${analysis.score}/100</b>`,
    analysis.summary ? f.escapeHtml(analysis.summary) : null,
    d.good?.[0] ? `✅ ${f.escapeHtml(d.good[0])}` : null,
    d.improve?.[0] ? `💡 ${f.escapeHtml(d.improve[0])}` : null,
    f.portalLink(`/calls/${call.id}`, "Batafsil koʻrish"),
  ];
  await notifyUser(user.id, "callReviews", lines.filter(Boolean).join("\n"), undefined, { appExtra: { tag: `call-review-${call.id}` } });
  await prisma.callAnalysis.update({ where: { id: analysis.id }, data: { notifiedAt: new Date() } });
}

// Calls transcribed but not reviewed yet (Claude was off or failed): a few
// at a time.
async function tick() {
  if (!(await claudeFeatureOn("callReview"))) return 0;
  const rows = await prisma.transcript.findMany({
    where: { status: "done", callLog: { analysis: null, missed: false, durationSeconds: { gte: MIN_TALK_SEC } } },
    orderBy: { updatedAt: "desc" },
    take: 5,
    select: { callLogId: true },
  });
  let done = 0;
  for (const r of rows) {
    try {
      if (await reviewCall(r.callLogId)) done += 1;
    } catch (err) {
      console.error(`[call-review] call ${r.callLogId}:`, err.message);
    }
  }
  return done;
}

// A manager's check: { correct, note }.
async function setFeedback(callLogId, user, { correct, note }) {
  return prisma.callAnalysis.update({
    where: { callLogId },
    data: { feedbackCorrect: correct === null ? null : Boolean(correct), feedbackNote: note ? String(note).slice(0, 500) : null, feedbackById: user.id, feedbackAt: new Date() },
  });
}

module.exports = { DEFAULT_RULES, CRITERIA, LABELS, MAX, SCHEMA, MIN_TALK_SEC, reviewSettings, transcriptText, clean, reviewable, reviewCall, tick, setFeedback, lessons };
