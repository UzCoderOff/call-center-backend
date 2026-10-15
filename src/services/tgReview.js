const prisma = require("../lib/prisma");
const { firmNow } = require("../lib/firmTime");
const { getSetting } = require("../lib/settings");
const { claudeFeatureOn } = require("./ai/settings");
const inbox = require("./tgInbox");

// The AI review of the firm's Telegram chats (BETA, 2026-10-15) — reads, never
// writes to the client. Once a chat has been quiet for a while, Claude reads
// it and says:
//   - is it about the firm's work at all (spam, a wrong number, a job seeker,
//     a personal chat: not) — a new chat that isn't goes out of the list
//     (hidden, "by the AI"; a person can bring it back, and then it stays);
//   - what happened (booked, lost — whose fault, still open…), how the
//     operator did (1-5), what was good, what to do next time, a better reply.
// Judged by the firm's own rules for operators (Sozlamalar → Mijozlar
// Telegrami, editable). Shown on the chat and in Natijalar, marked Beta.
// Uses Claude Haiku by default (cheap; tried in voice-lab/review first), on
// the firm's Claude key, its monthly cap and the "tgReview" switch.
//
// AI replies to clients are NOT built (the firm's call, 2026-10-15): later.

const DEFAULT_RULES = [
  "Konsultatsiya: 450 000 soʻm, advokat bilan.",
  "Tartib: avval mijozning muammosini bilib oling — salomlashing, nima boʻlganini soʻrang, tinglang. Muammo tushunarli boʻlgach, konsultatsiyani taklif qiling: «Sizni hozir advokatimiz konsultatsiyasiga yozib qoʻyaymi?». Muammoni bilmay turib darrov yozishga shoshilmang.",
  "Narxni soʻrashsa — aniq ayting va masalasi nima ekanini soʻrang.",
  "Yozishda aniq vaqt taklif qiling (masalan, «ertaga 11:00 yoki 15:00»), ism va raqamni oling.",
  "Ish vaqtida tez javob bering — 15 daqiqa ichida.",
  "Operator yuridik xulosa bermaydi — bu advokatning ishi; operator konsultatsiyani taklif qiladi.",
  "Mijoz qaysi tilda yozsa (oʻzbek yoki rus), oʻsha tilda javob bering.",
].join("\n");

// Claude Haiku: the model the firm tried (voice-lab/review). It takes the
// forced "review" tool; the bigger models answer that with an error.
const MODELS = ["claude-haiku-5-5"];
const REVIEW_DEFAULTS = { rules: "", reviewModel: MODELS[0] };
const OUTCOMES = ["booked", "lost_by_us", "lost_not_serious", "lost_other", "open", "not_client"];
const POTENTIALS = ["high", "medium", "low", "none"];

// Quiet this long before a review (the conversation has paused).
const QUIET_MS = 60 * 60 * 1000;
// Only chats with something new in the last week.
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const PER_TICK = 8;
const MAX_MESSAGES = 150;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["relevant", "topic", "outcome", "potential", "score", "summary", "lossReason", "good", "improve", "betterReply"],
  properties: {
    relevant: {
      type: "boolean",
      description:
        "Is this a person with a legal matter the firm could help with (a possible or current client)? false for spam, ads, a wrong number, a job seeker, a supplier, a personal chat. Someone who only greeted a law firm counts as true",
    },
    topic: { type: "string", description: "The legal area in a few Uzbek words («Oila — ajrashish», «Meros», «Mehnat nizosi»), or what it is if not relevant («Reklama», «Ish soʻrab»)" },
    outcome: {
      type: "string",
      enum: OUTCOMES,
      description:
        "booked = konsultatsiyaga yozildi; lost_by_us = operator tufayli yoʻqotildi; lost_not_serious = niyati jiddiy emas edi; lost_other = boshqa sabab, operator yaxshi ishlagan; open = hali hal boʻlmagan; not_client = mijoz emas",
    },
    potential: { type: "string", enum: POTENTIALS, description: "How likely this person was to become a client at the start" },
    score: { type: "integer", minimum: 0, maximum: 5, description: "The operator's handling, 1-5 (0 = nothing to judge)" },
    summary: { type: "string", description: "1-2 sentences: what the person wanted and how it ended" },
    lossReason: { type: "string", description: "If lost: the main reason, plainly. Else empty" },
    good: { type: "array", items: { type: "string" }, maxItems: 3, description: "What the operator did well" },
    improve: { type: "array", items: { type: "string" }, maxItems: 3, description: "Next time do this — only for real mistakes" },
    betterReply: { type: "string", description: "Only after a real mistake: the message the operator could have sent at the key moment. Else empty" },
  },
};

const SYSTEM = (rules) => `You review a law firm operator's Telegram conversation with a person who wrote to the firm, the way a kind senior colleague coaches a junior one.

The firm and its rules for operators:
${rules}

Decide:
- Is this chat about the firm's work at all — a person with a legal matter (a possible client), or not (spam, ads, a wrong number, a job seeker, a personal chat)? Someone who only greeted a law firm and hasn't said more yet still counts as relevant.
- Did the person become a client (booked a consultation)? If not, why: the operator's fault (slow, too short, unclear, wrong language, no concrete time offered, gave a legal conclusion, didn't follow the rules above), the person wasn't serious (just asking, no real intention), or something else (price, distance) while the operator did fine. If the conversation is still going, "open".
- How promising the person was at the start.
- Score the operator's handling 1-5 (0 if there is nothing to judge).
Be fair: answering a late-night message the next morning in working hours is fine. Use only what is in the conversation; don't invent facts. Voice messages and photos can't be read here — judge from the rest, and don't blame the operator for what you can't see.

Advice only where it's earned:
- "improve" and "betterReply" are for real mistakes against the rules above. If the operator did well (score 4-5), leave "betterReply" empty and "improve" empty (or one small tip). Never suggest a reply that isn't clearly better than what the operator actually wrote.
- If the chat isn't about the firm's work (relevant = false): score 0, and leave "good", "improve", "betterReply" and "lossReason" empty.

Write every text in Uzbek (Latin script, with oʻ and gʻ), short and plain, speaking to the operator as "siz".

Record the review with the review tool.`;

async function reviewSettings() {
  const s = await getSetting(inbox.SETTINGS_KEY, { ...inbox.DEFAULTS, ...REVIEW_DEFAULTS });
  return { rules: String(s.rules || "").trim() || DEFAULT_RULES, customRules: Boolean(String(s.rules || "").trim()), reviewModel: MODELS.includes(s.reviewModel) ? s.reviewModel : MODELS[0] };
}

const pad = (n) => String(n).padStart(2, "0");
function stamp(date) {
  const now = firmNow(date);
  return `${now.date} ${pad(Math.floor(now.minutes / 60))}:${pad(now.minutes % 60)}`;
}
const clock = (s) => `${Math.floor(s / 60)}:${pad(s % 60)}`;

// What a message says, for someone reading the chat as text.
function words(m) {
  if (m.deletedAt) return "[oʻchirilgan xabar]";
  const text = m.text || "";
  switch (m.kind) {
    case "text":
      return text;
    case "voice":
      return `[ovozli xabar${m.duration ? `, ${clock(m.duration)}` : ""} — eshitib boʻlmaydi]`;
    case "video_note":
      return "[video xabar — koʻrib boʻlmaydi]";
    case "photo":
      return `[rasm]${text ? ` ${text}` : ""}`;
    case "video":
      return `[video]${text ? ` ${text}` : ""}`;
    case "document":
      return `[fayl: ${m.fileName || "hujjat"}]${text ? ` ${text}` : ""}`;
    case "audio":
      return "[audio]";
    case "sticker":
      return `[stiker ${text}]`.trim();
    case "contact":
      return `[kontakt: ${text}]`;
    case "location":
      return "[joylashuv]";
    default:
      return text || "[xabar]";
  }
}

// The firm's away / greeting message, said as such.
const who = (m) => (m.out ? (m.auto ? "AVTOMATIK XABAR" : "OPERATOR") : "MIJOZ");

// The chat as the model reads it: when, who, and how long the person waited.
function transcript(messages) {
  let waitingSince = null;
  return messages
    .map((m) => {
      const at = new Date(m.sentAt);
      let note = "";
      if (m.out && !m.auto && waitingSince) {
        note = ` (mijoz ${Math.max(0, Math.round((at - waitingSince) / 60000))} daqiqa kutdi)`;
        waitingSince = null;
      }
      if (!m.out && !waitingSince && !m.deletedAt) waitingSince = at;
      return `[${stamp(at)}] ${who(m)}${note}: ${words(m)}`;
    })
    .join("\n");
}

// Whatever came back, the same shape.
function clean(r) {
  const list = (x) => (Array.isArray(x) ? x.map((v) => String(v).trim()).filter(Boolean).slice(0, 3) : x ? [String(x).trim()] : []);
  const text = (x, max = 2000) => (x == null ? "" : String(x).trim().slice(0, max));
  const relevant = r.relevant === true || r.relevant === "true";
  return {
    relevant,
    topic: text(r.topic, 80) || null,
    outcome: OUTCOMES.includes(r.outcome) ? r.outcome : relevant ? "open" : "not_client",
    potential: POTENTIALS.includes(r.potential) ? r.potential : null,
    score: Math.max(0, Math.min(5, Math.round(Number(r.score) || 0))),
    summary: text(r.summary) || null,
    lossReason: text(r.lossReason) || null,
    good: list(r.good),
    improve: list(r.improve),
    betterReply: text(r.betterReply) || null,
  };
}

// Review one chat now. -> the TgReview row, or null when there's nothing to read.
async function reviewChat(chatId) {
  const claude = require("./ai/claude");
  // What it has read: up to now (a message during the call is read next time).
  const reviewedAt = new Date();
  const chat = await prisma.tgChat.findUnique({ where: { id: chatId } });
  if (!chat) return null;
  const rows = await prisma.tgMessage.findMany({
    where: { chatId, sentAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) } },
    orderBy: [{ sentAt: "desc" }, { id: "desc" }],
    take: MAX_MESSAGES,
  });
  const messages = rows.reverse();
  if (!messages.some((m) => !m.out)) {
    await prisma.tgChat.update({ where: { id: chatId }, data: { reviewedAt } });
    return null;
  }
  const { rules, reviewModel } = await reviewSettings();
  const response = await claude.create(
    {
      model: reviewModel,
      max_tokens: 2000,
      system: SYSTEM(rules),
      messages: [{ role: "user", content: `Telegram yozishmasi (${inbox.displayName(chat)}):\n\n${transcript(messages)}` }],
      tools: [{ name: "review", description: "Record the review of this conversation.", input_schema: SCHEMA }],
      tool_choice: { type: "tool", name: "review" },
    },
    { feature: "tgReview" }
  );
  const used = (response.content || []).find((b) => b.type === "tool_use");
  if (!used?.input) {
    // Nothing usable (declined, cut off): look again when something new comes.
    await prisma.tgChat.update({ where: { id: chatId }, data: { reviewedAt } });
    return null;
  }
  const r = clean(used.input);
  const lastOut = [...messages].reverse().find((m) => m.out && !m.auto && m.answeredById);
  const operatorId = lastOut?.answeredById ?? (await answeringNow());
  const review = await prisma.tgReview.create({
    data: {
      chatId,
      operatorId,
      upToMessageId: messages[messages.length - 1].id,
      ...r,
      model: response.model || reviewModel,
      costUsd: claude.costOf(response.model || reviewModel, response.usage),
    },
  });

  // Not about the firm's work, and a new person (no client): out of the list —
  // unless a person already brought it back after the AI hid it before, or
  // the answer was cut short (then it can't be trusted to hide anything).
  const data = { reviewedAt, ...(r.topic ? { topic: r.topic } : {}) };
  const surelyNot = used.input.relevant === false && response.stop_reason !== "max_tokens";
  if (surelyNot && !chat.clientId && !chat.hidden) {
    const hiddenBefore = await prisma.tgReview.count({ where: { chatId, relevant: false, id: { not: review.id } } });
    if (!hiddenBefore) Object.assign(data, { hidden: true, aiHidden: true });
  }
  // The AI hid it, but now it is about the firm's work: back in the list.
  if (r.relevant && chat.aiHidden) Object.assign(data, { hidden: false, aiHidden: false });
  await prisma.tgChat.update({ where: { id: chatId }, data });
  inbox.bumpInbox();
  return review;
}

async function answeringNow() {
  const { operatorIds } = await getSetting(inbox.SETTINGS_KEY, inbox.DEFAULTS);
  return Array.isArray(operatorIds) && operatorIds.length === 1 ? operatorIds[0] : null;
}

// Every 10 minutes (services/scheduler.js): the chats that have paused since
// their last look.
async function tick(now = Date.now()) {
  if (!(await claudeFeatureOn("tgReview"))) return 0;
  const todo = await prisma.tgChat.findMany({
    where: {
      AND: [
        { OR: [{ hidden: false }, { aiHidden: true }] },
        { OR: [{ reviewedAt: null }, { reviewedAt: { lt: prisma.tgChat.fields.lastMessageAt } }] },
      ],
      lastInAt: { not: null },
      lastMessageAt: { lt: new Date(now - QUIET_MS), gt: new Date(now - RECENT_MS) },
    },
    orderBy: { lastMessageAt: "asc" },
    select: { id: true },
    take: PER_TICK,
  });
  let done = 0;
  for (const c of todo) {
    try {
      if (await reviewChat(c.id)) done += 1;
      failures.delete(c.id);
    } catch (err) {
      const { ClaudeError } = require("./ai/claude");
      console.error(`[tg-review] chat ${c.id}: ${err.message}`);
      // No key or a wrong one, the month's cap, no credit left, Claude busy,
      // a setting Claude refuses: nothing is wrong with the chat — next time.
      // The same chat failing again and again: let it be until something new.
      const tries = (failures.get(c.id) || 0) + 1;
      failures.set(c.id, tries);
      if (tries >= 3) {
        failures.delete(c.id);
        await prisma.tgChat.update({ where: { id: c.id }, data: { reviewedAt: new Date() } }).catch(() => {});
        continue;
      }
      if (err instanceof ClaudeError || [400, 401, 403, 404, 429].includes(err.status) || err.status >= 500 || /credit balance/i.test(err.message)) break;
      await prisma.tgChat.update({ where: { id: c.id }, data: { reviewedAt: new Date() } }).catch(() => {});
    }
  }
  return done;
}

// Chats Claude failed on, and how often in a row (in memory: a restart forgets).
const failures = new Map();

function reviewLine(r) {
  if (!r) return null;
  return {
    id: r.id,
    at: r.createdAt,
    relevant: r.relevant,
    topic: r.topic,
    outcome: r.outcome,
    potential: r.potential,
    score: r.score,
    summary: r.summary,
    lossReason: r.lossReason,
    good: Array.isArray(r.good) ? r.good : [],
    improve: Array.isArray(r.improve) ? r.improve : [],
    betterReply: r.betterReply,
    operator: r.operator ? r.operator.employee?.name || r.operator.name || r.operator.username : null,
    model: r.model,
  };
}

module.exports = { DEFAULT_RULES, MODELS, OUTCOMES, SCHEMA, reviewSettings, transcript, words, clean, reviewChat, tick, reviewLine, QUIET_MS };
