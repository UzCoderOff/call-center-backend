const prisma = require("../lib/prisma");
const { jobWhere } = require("../lib/jobs");
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
  "Firma: «Xondamir Azamovich» advokatlik firmasi. Konsultatsiyani firma rahbari — advokat Xondamir Azamovichning oʻzi shaxsan oʻtkazadi: ofisda — 600 000 soʻm, videoaloqa orqali — 450 000 soʻm, toʻlov oldindan. Firma mehnat nizolarini olmaydi. Operator yuridik masalani oʻzi hal qilmaydi: maqsad — mijozni eshitish, tushunish va konsultatsiyaga yozish.",
  "Mezonlar (jami 100 ball):",
  "1. Salomlashish (10): firma nomi, oʻz ismi, mijozning ismini soʻradi («Sizga qanday murojaat qilsam boʻladi?» — bu ismini soʻrash) va keyin ismi bilan murojaat qildi.",
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
  "Narxlar: 450 000 soʻm (videoaloqa) va 600 000 soʻm (ofis) — ikkalasi ham firmaning haqiqiy narxi. Faqat bittasini aytish xato emas (formatni ham aytsa yaxshiroq). Avtomatik matnda raqamlar buzilishi mumkin: «tort yuz ellik ming son» = 450 000 soʻm.",
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
// The gross errors of the standard (−20 each) — only these count.
const GROSS = ["legal_advice", "promised_result", "made_up_deadline_or_discount", "rude", "case_info_to_existing_client"];
const GROSS_LABELS = {
  legal_advice: "Yuridik maslahat yoki xulosa berdi",
  promised_result: "Natija vaʼda qildi yoki foizda imkoniyat aytdi",
  made_up_deadline_or_discount: "Oʻylab topilgan muddat yoki chegirma ishlatdi",
  // (the firm's own prices, 450 000 and 600 000, are never this)
  rude: "Mijozga qoʻpollik qildi",
  case_info_to_existing_client: "Ishlayotgan mijozga uning ishi haqida maʼlumot berdi",
};
const OUTCOMES = ["booked", "not_booked", "existing", "not_client"];
// Calls shorter than this aren't reviewed (a wrong number, "call me later").
// Every answered operator call from MIN_TEXT_SEC gets its text and a short
// summary (what the caller wanted, how it ended) — a 16-second "I already
// found a lawyer" matters too (2026-10-25). Only from MIN_TALK_SEC is the
// operator scored.
const MIN_TALK_SEC = 20;
const MIN_TEXT_SEC = 5;
const LESSONS = 10;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "topic", "outcome", "about", "lost", "criteria", "grossErrors", "good", "improve", "betterLines"],
  properties: {
    kind: {
      type: "string",
      enum: KINDS,
      description: "lead = a new person asking for legal help; existing = someone the firm already works with (asking about their case, sending documents); not_relevant = a wrong number, an ad, a job seeker, a personal call, a colleague or a test call, or a transcript too garbled to tell what the call was about (such calls are not scored)",
    },
    topic: { type: "string", description: "The legal area in a few Uzbek words («Jinoyat — chaqiruv», «Oila — ajrashish»), or what the call was if not relevant" },
    outcome: { type: "string", enum: OUTCOMES, description: "booked = the client was booked for a consultation in this call; not_booked = a lead that wasn't booked; existing / not_client as the kind" },
    about: { type: "string", description: "One or two Uzbek sentences: what the caller wanted and how the call ended (booked, will think, went to another lawyer, not a client…). No advice, no next step" },
    lost: { type: "boolean", description: "true when the caller is lost to the firm in this call: says the matter is already settled, found another lawyer, no longer needs us, or refuses" },
    lostCause: {
      type: "string",
      enum: ["late_callback", "operator", "client", "unknown"],
      description: "only when lost: late_callback = they had called before and weren't called back in time (see the history: 'kech'); operator = the operator's handling in this call lost them; client = the client's own reasons (price, distance, changed mind) despite good handling; unknown",
    },
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
    grossErrors: {
      type: "array",
      maxItems: 5,
      description: "Only gross errors that really happened in this call (−20 each), each with the operator's words that show it. An empty list when there were none — never list an absence",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "quote"],
        properties: {
          key: {
            type: "string",
            enum: GROSS,
            description:
              "legal_advice = the operator says what the law says or what the client should do legally or will get («borishingiz shart emas», «sizga 3 yil beriladi», «prokuraturaga ariza yozing»); recommending to see the firm's lawyer or a consultation is NOT this — it is the operator's job. promised_result = «yutamiz», «100 foiz», «pulingizni qaytaramiz». made_up_deadline_or_discount = a discount or deadline that isn't real («faqat bugun 50% chegirma»); the firm's own prices, 450 000 and 600 000 soʻm, are never this. rude = insulting, mocking or shouting at the client. case_info_to_existing_client = telling a client in work about their case instead of passing them to their coordinator",
          },
          quote: { type: "string", description: "What the operator said" },
        },
      },
    },
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

The call is a transcript made automatically from the recording (Uzbek speech recognition): lines marked "Operator" are the firm's operator, "Mijoz" the caller; a recording that couldn't be split is marked "Suhbat". Recognition makes mistakes — misheard words, missing words — so judge the meaning, never spelling, and don't blame the operator for what may be a recognition error. Read words in context: common mix-ups are «bitta» for «bitdi» («ishim bor edi, bitdi» = the matter is already settled), «boʻldi» (= enough / it's done), «lejer/lider» for «Ledger». Tone of voice isn't in a transcript: judge manner by the words.

You may also get the number's history before this call (missed calls, call-backs, earlier talks, bookings). Use it in «about»: e.g. "called twice at night, not answered; called back next morning — says the matter is already settled (likely went elsewhere)". Don't score the operator for what happened before this call.

Decide the kind of call first:
- lead: a new person with a legal question — judge all nine criteria by the standard.
- existing: someone the firm already works with — they aren't sold to: give full points for criteria that don't apply (listening and questions still count as relevant to helping them; "routing" is whether the operator connected them to their coordinator instead of discussing the case).
- not_relevant: a wrong number, an ad, a personal call, a colleague or a test call, or a transcript too garbled to tell what the call was about — it is not scored; still fill the fields briefly.
Give each criterion's points honestly (0 up to its maximum: greeting 10, routing 5, listening 15, questions 15, summary 10, offer 10, priceTime 15, closing 10, manner 10). List gross errors only if they clearly happened, quoting the operator; when in doubt, it is not a gross error — leave the list empty. Recommending a consultation with the firm's lawyer is the operator's job, never "legal advice". Misheard words (the transcript is automatic) are never the operator's mistake — don't take points for unclear wording.
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
// The AI's text with oʻ, gʻ, ʼ (it often writes o', g').
const uz = (text) => require("./pbx/transcribe").uzLetters(String(text || ""));

function clean(r) {
  const byKey = new Map((Array.isArray(r?.criteria) ? r.criteria : []).map((c) => [c.key, c]));
  const criteria = CRITERIA.map((key) => {
    const c = byKey.get(key) || {};
    return { key, points: Math.max(0, Math.min(MAX[key], Math.round(Number(c.points) || 0))), max: MAX[key], note: uz(c.note).slice(0, 400) };
  });
  const list = (v, n) => (Array.isArray(v) ? v : []).map((x) => uz(x).trim()).filter(Boolean).slice(0, n);
  const seen = new Set();
  const grossErrors = (Array.isArray(r?.grossErrors) ? r.grossErrors : [])
    .filter((g) => GROSS.includes(g?.key) && String(g?.quote || "").trim() && !seen.has(g.key) && seen.add(g.key))
    .map((g) => `${GROSS_LABELS[g.key]}: «${String(g.quote).trim().slice(0, 200)}»`);
  const sum = criteria.reduce((s, c) => s + c.points, 0);
  return {
    kind: KINDS.includes(r?.kind) ? r.kind : "lead",
    topic: uz(r?.topic).slice(0, 120),
    outcome: OUTCOMES.includes(r?.outcome) ? r.outcome : "not_booked",
    about: uz(r?.about).slice(0, 400),
    lost: r?.lost === true,
    lostCause: r?.lost === true && ["late_callback", "operator", "client", "unknown"].includes(r?.lostCause) ? r.lostCause : null,
    criteria,
    grossErrors,
    good: list(r?.good, 3),
    improve: list(r?.improve, 3),
    betterLines: (Array.isArray(r?.betterLines) ? r.betterLines : [])
      .map((b) => ({ said: uz(b?.said).trim().slice(0, 400), better: uz(b?.better).trim().slice(0, 400) }))
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
    .map((r) => `- ${r.details?.topic || "Qoʻngʻiroq"}: AI ${r.score == null ? "baholamagan" : `${r.score}/100 bergan`} — rahbar: ${r.feedbackCorrect ? "toʻgʻri" : "notoʻgʻri"}. ${r.feedbackNote}`)
    .join("\n");
}

// Whether a call is one to review: answered, long enough, an operator's
// (the call center) — and it has a transcript.
function reviewable(call) {
  return Boolean(call && !call.missed && call.durationSeconds >= MIN_TEXT_SEC && call.employee && isCallCenter(call.employee));
}

// Reviews one call now. -> the CallAnalysis row, or null.
// What happened with this number before the call (7 days): missed calls and
// call-backs, earlier talks, bookings — so the summary can say "called twice
// at night, not answered". Plain lines in Uzbek, firm time.
const HISTORY_DAYS = 7;
async function historyBefore(call) {
  if (!call.phoneKey) return { text: "", late: null };
  const { firmDate } = require("../lib/firmTime");
  const env = require("../config/env");
  const at = Number(call.callTimestampMs);
  const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: env.firmTimezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const [calls, bookings] = await Promise.all([
    prisma.callLog.findMany({
      where: { phoneKey: call.phoneKey, id: { not: call.id }, callTimestampMs: { gte: BigInt(at - HISTORY_DAYS * 86400000), lt: BigInt(at) } },
      orderBy: { callTimestampMs: "asc" },
      take: 12,
      select: { callType: true, missed: true, durationSeconds: true, callTimestampMs: true, employeeId: true, employee: { select: { name: true } } },
    }),
    prisma.appointment.findMany({ where: { phoneKey: call.phoneKey, createdAt: { lt: new Date(at) } }, orderBy: { createdAt: "desc" }, take: 3, select: { date: true, status: true } }),
  ]);
  if (!calls.length && !bookings.length) return { text: "", late: null };
  const line = (c) => {
    const when = stamp.format(new Date(Number(c.callTimestampMs)));
    const what = c.missed ? "javobsiz (mijoz qoʻngʻiroq qilgan, olinmagan)" : c.callType === "outgoing" ? `operator qoʻngʻiroq qilgan, ${clock(c.durationSeconds)}` : `mijoz qoʻngʻiroq qilgan, gaplashilgan ${clock(c.durationSeconds)}`;
    return `- ${when}: ${what} — ${c.employee?.name || ""}`;
  };
  const parts = ["Bu raqam bilan oldingi qoʻngʻiroqlar (oxirgi 7 kun):", ...calls.map(line)];
  if (bookings.length) parts.push(`Konsultatsiyalar: ${bookings.map((b) => `${b.date} (${b.status})`).join(", ")}`);
  const late = await callBackLateness(call, calls);
  if (late) parts.push(`Javobsiz qoʻngʻiroqqa birinchi javob — shu qoʻngʻiroq: muddat ${stamp.format(new Date(late.dueMs))} edi, ${late.minutes > 0 ? `${late.minutes} daqiqa kech (kech)` : "oʻz vaqtida"}.`);
  parts.push(`Shu qoʻngʻiroq: ${stamp.format(new Date(at))}, bugun ${firmDate()}.`);
  return { text: `${parts.join("\n")}\n\n`, late };
}

// This call answers missed calls nobody returned before it: when it was due
// by the firm's call-back rule (strikes.js — even while the rule is off) and
// how many minutes late it came. null when it isn't a call-back.
async function callBackLateness(call, earlier) {
  const at = Number(call.callTimestampMs);
  let firstMissed = null;
  for (const c of earlier) {
    if (c.missed) firstMissed = firstMissed ?? c;
    else firstMissed = null; // answered or called out since: those were dealt with
  }
  if (!firstMissed) return null;
  const { deadlineFor, strikeRules } = require("./strikes");
  const { workingDates } = require("./workdays");
  const { firmDate } = require("../lib/firmTime");
  const rules = await strikeRules();
  const missedMs = Number(firstMissed.callTimestampMs);
  const who = firstMissed.employeeId ? await prisma.employee.findUnique({ where: { id: firstMissed.employeeId }, select: { id: true, workDays: true, holidaysOff: true } }) : null;
  let works = () => true;
  if (who) {
    const days = await workingDates([who], firmDate(new Date(missedMs)), firmDate(new Date(at + 7 * 86400000)));
    const set = new Set(days.byEmployee.get(who.id)?.work || []);
    works = (date) => set.has(date);
  }
  const dueMs = deadlineFor(missedMs, rules, works);
  return { dueMs, minutes: Math.max(0, Math.round((at - dueMs) / 60000)) };
}

async function reviewCall(callLogId) {
  if (!(await claudeFeatureOn("callReview"))) return null;
  const claude = require("./ai/claude");
  const call = await prisma.callLog.findUnique({ where: { id: callLogId }, include: { employee: true, transcript: true } });
  if (!reviewable(call) || call.transcript?.status !== "done") return null;
  const segments = Array.isArray(call.transcript.segments) ? call.transcript.segments : [];
  if (!segments.length) return null;
  const { rules, model } = await reviewSettings();
  await prisma.callAnalysis.upsert({ where: { callLogId }, create: { callLogId, status: "processing" }, update: { status: "processing", errorMessage: null } });
  const history = await historyBefore(call);
  try {
    const response = await claude.create(
      {
        model,
        max_tokens: 3000,
        system: SYSTEM(rules, await lessons()),
        messages: [
          {
            role: "user",
            content: `${history.text}Qoʻngʻiroq: ${call.callType === "outgoing" ? "operator qoʻngʻiroq qildi" : "mijoz qoʻngʻiroq qildi"}, ${clock(call.durationSeconds)}. Operator: ${call.employee.name}.${call.durationSeconds < MIN_TALK_SEC ? " Qisqa qoʻngʻiroq: asosiysi — «about» (nima istadi, qanday tugadi); baho qoʻyilmaydi." : ""}\n\n${transcriptText(segments)}`,
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
    // Not a client call (a colleague, a test, a wrong number) or text too
    // garbled to judge: kept, but not scored — no number to the operator
    // and nothing toward their stars (2026-10-24: a test call got 86).
    // A short call (under MIN_TALK_SEC) gets its summary only — unless the
    // client was lost through us (a late call-back, or this call): that
    // always counts, with −20 for the lost client (2026-10-25: two night
    // calls returned next morning at 10:05, "ishim bitdi").
    const short = call.durationSeconds < MIN_TALK_SEC;
    const lostByUs = details.lost && (details.lostCause === "operator" || (details.lostCause === "late_callback" && history.late?.minutes > 0));
    if (lostByUs) {
      details.lateMinutes = history.late?.minutes ?? null;
      details.grossErrors = [
        ...details.grossErrors,
        details.lostCause === "late_callback" ? `Mijoz yoʻqotildi — qayta qoʻngʻiroq ${history.late.minutes} daqiqa kech` : "Mijoz shu qoʻngʻiroqda yoʻqotildi",
      ];
    }
    const scored = details.kind !== "not_relevant" && (!short || lostByUs);
    const finalScore = lostByUs ? Math.max(0, score - 20) : score;
    const row = await prisma.callAnalysis.update({
      where: { callLogId },
      data: { status: "done", score: scored ? finalScore : null, summary: about, details: { ...details, unscored: !scored, ...(short ? { short: true } : {}) }, model: response.model || model, costUsd: claude.costOf(response.model || model, response.usage) },
    });
    if (scored) await tellOperator(call, row).catch((err) => console.error("[call-review] telling the operator failed:", err.message));
    if (lostByUs) await tellManagers(call, row).catch((err) => console.error("[call-review] telling the managers failed:", err.message));
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
    where: { status: "done", text: { not: "" }, callLog: { analysis: null, missed: false, durationSeconds: { gte: MIN_TEXT_SEC }, employee: jobWhere(["call_center"]) } },
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

// A client lost through us -> the boss and the developer, once.
async function tellManagers(call, analysis) {
  const f = require("./telegram/format");
  const { notifyUser, linkedUsers, once } = require("./telegram/notify");
  const d = analysis.details || {};
  const text = [
    "🔴 <b>Mijoz yoʻqotildi</b>",
    `${f.escapeHtml(call.employee.name)} · ${f.escapeHtml(f.phone(call.phoneNumber))}`,
    d.lostCause === "late_callback" ? `Sabab: qayta qoʻngʻiroq ${d.lateMinutes} daqiqa kech` : "Sabab: shu qoʻngʻiroqdagi muomala",
    analysis.summary ? f.escapeHtml(analysis.summary) : null,
    f.portalLink(`/calls/${call.id}`, "Qoʻngʻiroqni ochish"),
  ]
    .filter(Boolean)
    .join("\n");
  for (const user of await linkedUsers({ role: { in: ["BOSS", "DEVELOPER"] } })) {
    await once(`lost-client:${call.id}:${user.id}`, () => notifyUser(user, "strikes", text));
  }
}

// A manager's check: { correct, note }.
async function setFeedback(callLogId, user, { correct, note }) {
  return prisma.callAnalysis.update({
    where: { callLogId },
    data: { feedbackCorrect: correct === null ? null : Boolean(correct), feedbackNote: note ? String(note).slice(0, 500) : null, feedbackById: user.id, feedbackAt: new Date() },
  });
}

module.exports = { GROSS, DEFAULT_RULES, CRITERIA, LABELS, MAX, SCHEMA, MIN_TALK_SEC, MIN_TEXT_SEC, reviewSettings, transcriptText, clean, reviewable, reviewCall, tick, setFeedback, lessons };
