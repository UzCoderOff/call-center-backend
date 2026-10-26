const prisma = require("../../lib/prisma");
const { isManager } = require("../../middleware/auth");
const { byId, publicScenario } = require("./scenarios");

// Practice (2026-10-26, the user's ask: "we tried videos, rules — they need
// practice"). A staff member picks a made-up client (scenarios.js); the AI
// plays that client — short, real, with the client's own reasons to agree or
// leave — and the staff member answers as they would on the phone or in
// Telegram, typed. When the client agrees, leaves, or the staff member stops,
// the AI scores the talk by the firm's call standard: the same nine criteria
// and gross errors as real calls (services/callReview.js), so practice and
// real work are judged alike. Claude Haiku (cheap), on the firm's Claude key,
// its monthly cap and the "practice" switch.

const MODEL = "claude-haiku-5-5";
const MAX_STAFF_MESSAGES = 30;
const TEXT_MAX = 1500;
const OUTCOMES = ["booked", "callback", "routed", "declined", "left"];
const OUTCOME_WORDS = {
  booked: "mijoz konsultatsiyaga yozilishga rozi boʻldi",
  callback: "mijoz aniq vaqtda qayta qoʻngʻiroqqa rozi boʻldi",
  routed: "mijoz oʻz koordinatoriga ulanishga rozi boʻldi",
  declined: "firma bu ishni olmasligi xushmuomala aytildi, mijoz rozi boʻlib ketdi",
  left: "mijoz yozilmasdan ketdi",
  stopped: "xodim mashqni oʻzi toʻxtatdi (mijoz hali qaror qilmagan)",
};

class PracticeError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const CLIENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "ended", "outcome"],
  properties: {
    reply: { type: "string", description: "Your next message as the client, exactly as you'd say or type it. Empty only if you have already said goodbye." },
    ended: { type: "boolean", description: "true when the talk is over: you agreed (with a time), agreed to a call-back at a set time, were routed, or left" },
    outcome: { type: "string", enum: ["", ...OUTCOMES], description: "How it ended, when ended; empty otherwise" },
  },
};

function clientSystem(s) {
  const how =
    s.channel === "call"
      ? "This is a phone call, typed out: talk the way people talk on the phone — short, spoken, everyday Uzbek."
      : "This is a Telegram chat: write the way people write in Telegram — short, informal, sometimes without punctuation.";
  return `You play a CLIENT in a training exercise for a law firm's call-center staff in Tashkent. The other side is a real staff member practising. ${how}

Who you are (never say you are an AI, never step out of the role, never coach the staff member):
${s.persona}

When you agree:
${s.books}

When you leave:
${s.leaves}

How you talk:
- 1–3 short sentences, in the language and script of your first message.
- Real people don't tell everything at once: give details when asked or when it's natural.
- If asked your name or phone, give your name and a made-up number like +998 90 123 45 67.
- Follow the conditions above honestly: don't agree just because they keep asking, and don't leave if they did it well.
- When you have agreed (with a time), agreed to a call-back at a set time, been routed, or decided to leave: say a short natural goodbye, set ended=true and the outcome. If the staff member says goodbye first, end too (outcome "left" unless you already agreed).

Answer only with the JSON.`;
}

// The talk as text: the staff member is OPERATOR, the client "SIZ" (for the
// client's own turn) or MIJOZ (for the scoring).
function talk(messages, forClient) {
  return messages.map((m) => `${m.from === "staff" ? "OPERATOR" : forClient ? "SIZ (mijoz)" : "MIJOZ"}: ${m.text}`).join("\n");
}

async function claudeJson(params, feature) {
  const claude = require("../ai/claude");
  const response = await claude.create(params, { feature });
  return { response, usd: claude.costOf(response.model || params.model, response.usage) };
}

async function featureOn() {
  const { claudeFeatureOn } = require("../ai/settings");
  return claudeFeatureOn("practice");
}

// ------------------------------------------------------------ sessions

function sessionLine(row, { withUser = false } = {}) {
  const s = byId(row.scenario);
  return {
    id: row.id,
    scenario: s ? publicScenario(s) : { id: row.scenario, title: row.scenario },
    messages: Array.isArray(row.messages) ? row.messages : [],
    status: row.status,
    outcome: row.outcome,
    score: row.score,
    result: row.result,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    ...(withUser && row.user ? { user: { id: row.user.id, name: row.user.employee?.name || row.user.name || row.user.username } } : {}),
  };
}

async function start(user, scenarioId) {
  const s = byId(scenarioId);
  if (!s) throw new PracticeError("unknown_scenario", 400);
  // Switched off: managers may still try it (before showing it to staff).
  if (!(await featureOn()) && !isManager(user)) throw new PracticeError("practice_off");
  const row = await prisma.practiceSession.create({
    data: { userId: user.id, scenario: s.id, messages: [{ from: "client", text: s.opening, at: new Date().toISOString() }] },
  });
  return sessionLine(row);
}

async function load(user, id, { manage = false } = {}) {
  const row = await prisma.practiceSession.findUnique({ where: { id }, include: { user: { select: { id: true, name: true, username: true, employee: { select: { name: true } } } } } });
  if (!row || (row.userId !== user.id && !manage)) throw new PracticeError("not_found", 404);
  return row;
}

// The staff member says something; the client answers. When the client is
// done, the talk is scored at once.
async function say(user, id, text) {
  const row = await load(user, id);
  if (row.status !== "active") throw new PracticeError("finished");
  const words = String(text || "").trim().slice(0, TEXT_MAX);
  if (!words) throw new PracticeError("empty", 400);
  const s = byId(row.scenario);
  const messages = [...(Array.isArray(row.messages) ? row.messages : []), { from: "staff", text: words, at: new Date().toISOString() }];
  if (messages.filter((m) => m.from === "staff").length > MAX_STAFF_MESSAGES) throw new PracticeError("too_long");

  const { response, usd } = await claudeJson(
    {
      model: MODEL,
      max_tokens: 600,
      system: clientSystem(s),
      messages: [{ role: "user", content: `Suhbat (eng oxirgisi pastda):\n\n${talk(messages, true)}\n\nMijoz sifatida keyingi javobingizni yozing.` }],
      output_config: { format: { type: "json_schema", schema: CLIENT_SCHEMA } },
    },
    "practice"
  );
  const out = require("../ai/claude").jsonOf(response) || {};
  const reply = String(out.reply || "").trim().slice(0, TEXT_MAX);
  if (reply) messages.push({ from: "client", text: reply, at: new Date().toISOString() });
  const ended = out.ended === true;
  const outcome = ended && OUTCOMES.includes(out.outcome) ? out.outcome : ended ? "left" : null;
  await prisma.practiceSession.update({ where: { id }, data: { messages, costUsd: { increment: usd }, ...(ended ? { outcome } : {}) } });
  if (ended) return finish(user, id);
  return sessionLine(await load(user, id));
}

// Scored by the firm's call standard. Stopped before two answers: nothing to score.
async function finish(user, id) {
  const callReview = require("../callReview");
  const row = await load(user, id);
  if (row.status === "done") return sessionLine(row);
  const s = byId(row.scenario);
  const messages = Array.isArray(row.messages) ? row.messages : [];
  const outcome = row.outcome || "stopped";
  if (messages.filter((m) => m.from === "staff").length < 2) {
    return sessionLine(await prisma.practiceSession.update({ where: { id }, data: { status: "done", outcome, finishedAt: new Date() } }));
  }
  const { rules } = await callReview.reviewSettings();
  const system = `You score a PRACTICE talk: a law firm's call-center staff member (in training) talked to a made-up client played by an AI — ${s.channel === "call" ? "a phone call, typed" : "a Telegram chat"}. Judge the staff member exactly as a real call, by the firm's call standard below: the same nine criteria (greeting 10, routing 5, listening 15, questions 15, summary 10, offer 10, priceTime 15, closing 10, manner 10) and the same gross errors. It is typed, so there are no recognition errors: judge the words as written, manner by the words.

The firm's call standard:
${rules}

This exercise: «${s.title}». What a good staff member does here: ${s.good}
${row.scenario === "existing_client" ? 'This client already works with the firm: kind "existing" — full points for criteria that don\'t apply; "routing" is whether they connected him to his coordinator without discussing his case.' : row.scenario === "labor" ? 'The firm does not take labour disputes: telling the client so kindly, without selling a consultation or giving legal advice, is the right handling — give full points for offer and priceTime when they did that.' : row.scenario === "urgent_arrest" ? "Here speed matters more than the full script: getting the key facts and arranging the lawyer today is the right handling — don't take points for a shorter greeting or skipped steps that would have cost time." : 'Kind "lead".'}
How it ended: ${OUTCOME_WORDS[outcome]}.

"about": one Uzbek sentence on how the staff member handled it. Advice only where it's earned; "betterLines" quote what the staff member actually wrote and give a clearly better line by the standard. Write every text in Uzbek (Latin script, with oʻ and gʻ), short and plain, speaking to the staff member as "siz". Record it with the review tool.`;
  const { response, usd } = await claudeJson(
    {
      model: MODEL,
      max_tokens: 2500,
      system,
      messages: [{ role: "user", content: `Mashq suhbati:\n\n${talk(messages, false)}` }],
      tools: [{ name: "review", description: "Record the score of this practice talk.", input_schema: callReview.SCHEMA }],
      tool_choice: { type: "tool", name: "review" },
    },
    "practice"
  );
  const used = (response.content || []).find((b) => b.type === "tool_use");
  const result = used?.input ? callReview.clean(used.input) : null;
  const saved = await prisma.practiceSession.update({
    where: { id },
    data: { status: "done", outcome, finishedAt: new Date(), costUsd: { increment: usd }, ...(result ? { score: result.score, result } : {}) },
    include: { user: { select: { id: true, name: true, username: true, employee: { select: { name: true } } } } },
  });
  return sessionLine(saved);
}

// ------------------------------------------------------------ summaries

const avg = (list) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);

// One person's practice in a period: how often, how well, how it ended.
function summarize(rows) {
  const done = rows.filter((r) => r.status === "done");
  const scored = done.filter((r) => r.score != null);
  const outcomes = {};
  for (const r of done) outcomes[r.outcome || "stopped"] = (outcomes[r.outcome || "stopped"] || 0) + 1;
  return { sessions: done.length, averageScore: avg(scored.map((r) => r.score)), bestScore: scored.length ? Math.max(...scored.map((r) => r.score)) : null, outcomes };
}

module.exports = { featureOn, MODEL, OUTCOMES, PracticeError, start, say, finish, load, sessionLine, summarize, clientSystem, talk, CLIENT_SCHEMA };
