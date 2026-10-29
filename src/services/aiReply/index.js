const prisma = require("../../lib/prisma");
const { firmNow, shiftDate, weekStartOf } = require("../../lib/firmTime");
const { getSetting, setSetting } = require("../../lib/settings");
const { MANAGER_ROLES } = require("../../middleware/auth");
const cal = require("../calendar");
const inbox = require("../tgInbox");
const P = require("./prompt");

// The AI that answers NEW people in the firm's chats (Telegram, Instagram),
// 2026-10-26. It learns their problem, shows why a consultation helps and
// gets them to agree to one — then tells the operators, who confirm the time
// and the payment. No legal answers, no payments, no booking by itself.
//
// When it answers — per platform (Sozlamalar → Mijozlar xabarlari → AI):
//   off      — never;
//   draft    — it only suggests a reply in Ledger; a person sends it;
//   slow     — when nobody from the firm has answered within N minutes;
//   offhours — straight away, outside the firm's working hours only;
//   always   — straight away.
// Only chats with someone new: they wrote first, after the AI was switched on
// for that platform, no client linked. A person from the firm writing in a
// chat makes it step back (tgInbox.AI_PAUSE_MS); staff can stop it there or
// give it back. It hands over (and stops) for urgent matters, angry people,
// existing clients, payments, or anyone asking for a person.
//
// Every reply gets a second look before it goes (prompt.js CHECK) — a reply
// with legal advice, a promise or a made-up fact is not sent; a person is
// told instead. Its own monthly cap (capUsd) keeps the rest of the AI budget
// for Ledger AI.

const SETTINGS_KEY = "aiReply";
const MODES = ["off", "draft", "slow", "offhours", "always"];
const PLATFORMS = ["telegram", "instagram"];
const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "gpt-4o-mini", "gpt-5-mini"];
const DEFAULTS = {
  telegram: "off",
  instagram: "off",
  slowMinutes: 5,
  hoursFrom: 9 * 60,
  hoursTo: 21 * 60,
  capUsd: 15,
  model: MODELS[0],
  facts: "",
  rules: "",
  calendarId: null,
  // When each platform was switched on: older chats are left to people.
  since: {},
};

// Their last message this long ago before an answer — a few quick messages
// get one reply, as a person would. (AI_REPLY_GATHER_MS: shorter, for tests.)
const GATHER_MS = Number(process.env.AI_REPLY_GATHER_MS) || 40 * 1000;
// Telegram and Instagram allow replies within 24 hours of their message.
const WINDOW_MS = 23 * 60 * 60 * 1000;
const MAX_PER_CHAT_DAY = 15;
const MAX_PER_HOUR = 60;
const PER_TICK = 4;
const HISTORY = 30;

// USD per 1M tokens (in, out) of the OpenAI models it may use; Claude's are
// in ai/claude.js.
const OPENAI_PRICES = { "gpt-4o-mini": [0.15, 0.6], "gpt-5-mini": [0.25, 2] };

async function settings() {
  const s = { ...DEFAULTS, ...(await getSetting(SETTINGS_KEY, {})) };
  for (const p of PLATFORMS) if (!MODES.includes(s[p])) s[p] = "off";
  if (!MODELS.includes(s.model)) s.model = DEFAULTS.model;
  return s;
}

const factsOf = (s) => String(s.facts || "").trim() || P.DEFAULT_FACTS;
const rulesOf = (s) => String(s.rules || "").trim() || P.DEFAULT_RULES;

// A manager changes the settings. Switching a platform on starts its clock:
// only chats from then on.
async function saveSettings(changes, user) {
  const s = await settings();
  const next = { ...s };
  for (const p of PLATFORMS) {
    if (changes[p] === undefined) continue;
    if (!MODES.includes(changes[p])) throw Object.assign(new Error(`bad mode for ${p}`), { status: 400 });
    if (s[p] === "off" && changes[p] !== "off") next.since = { ...next.since, [p]: new Date().toISOString() };
    next[p] = changes[p];
  }
  const num = (v, min, max) => Math.max(min, Math.min(max, Math.round(Number(v))));
  if (changes.slowMinutes !== undefined) next.slowMinutes = num(changes.slowMinutes, 1, 120);
  if (changes.hoursFrom !== undefined) next.hoursFrom = num(changes.hoursFrom, 0, 1439);
  if (changes.hoursTo !== undefined) next.hoursTo = num(changes.hoursTo, 1, 1440);
  if (changes.capUsd !== undefined) next.capUsd = num(changes.capUsd, 0, 500);
  if (changes.model !== undefined) {
    if (!MODELS.includes(changes.model)) throw Object.assign(new Error("bad model"), { status: 400 });
    next.model = changes.model;
  }
  if (changes.facts !== undefined) next.facts = String(changes.facts || "").slice(0, 6000);
  if (changes.rules !== undefined) next.rules = String(changes.rules || "").slice(0, 8000);
  if (changes.calendarId !== undefined) next.calendarId = changes.calendarId ? Number(changes.calendarId) : null;
  await setSetting(SETTINGS_KEY, next, user?.id ?? null);
  return next;
}

// ------------------------------------------------------------ money

async function usageNow() {
  const month = firmNow().date.slice(0, 7);
  const all = await getSetting("aiReplyUsage", {});
  return { month, ...(all[month] || { usd: 0, replies: 0, drafts: 0, blocked: 0 }) };
}

// usd spent, and one more of `what` ("replies" | "drafts" | "blocked"), if given.
async function recordUsage(usd, what) {
  const month = firmNow().date.slice(0, 7);
  const all = await getSetting("aiReplyUsage", {});
  const m = all[month] || { usd: 0, replies: 0, drafts: 0, blocked: 0 };
  const next = { ...m, usd: m.usd + usd, ...(what ? { [what]: (m[what] || 0) + 1 } : {}) };
  const kept = Object.fromEntries(Object.entries({ ...all, [month]: next }).sort(([a], [b]) => b.localeCompare(a)).slice(0, 12));
  await setSetting("aiReplyUsage", kept, null);
}

// ------------------------------------------------------------ the model

// One JSON answer in `schema`. -> { out, usd, model }
async function ask(model, { system, prompt, schema, maxTokens }) {
  if (/^claude-/.test(model)) {
    const claude = require("../ai/claude");
    const response = await claude.create(
      { model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }], output_config: { effort: "low", format: { type: "json_schema", schema } } },
      { feature: "aiReply" }
    );
    return { out: claude.jsonOf(response), usd: claude.costOf(response.model || model, response.usage), model: response.model || model };
  }
  const { apiKey } = require("../ai/settings");
  const openai = require("../ai/openai");
  const key = await apiKey();
  if (!key) throw Object.assign(new Error("OpenAI key isn't set (Sozlamalar → Sunʼiy intellekt)"), { code: "no_key" });
  const { message, usage } = await openai.complete(key, { model, maxTokens, schema, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] });
  let out = null;
  try {
    out = JSON.parse(message.content || "");
  } catch {}
  const price = OPENAI_PRICES[model] || [0, 0];
  const usd = ((usage?.prompt_tokens || 0) * price[0] + (usage?.completion_tokens || 0) * price[1]) / 1e6;
  return { out, usd, model };
}

// ------------------------------------------------------------ facts for it

const inHours = (s, minutes) => minutes >= s.hoursFrom && minutes < s.hoursTo;

// A few free consultation times in the next days from the consultation
// calendar (the boss's, unless another is chosen): two a day at most — one
// in the morning, one later — not within the next hour.
async function freeTimes(s, now = firmNow()) {
  const calendar = s.calendarId
    ? await prisma.calendar.findUnique({ where: { id: s.calendarId } })
    : await prisma.calendar.findFirst({ where: { active: true, owner: { role: "BOSS", active: true } }, orderBy: { id: "asc" } });
  if (!calendar?.active) return [];
  const until = shiftDate(now.date, 3);
  const [weeks, appointments] = await Promise.all([
    prisma.calendarWeek.findMany({ where: { calendarId: calendar.id, status: "published", weekStart: { in: [...new Set([weekStartOf(now.date), weekStartOf(until)])] } } }),
    prisma.appointment.findMany({ where: { calendarId: calendar.id, date: { gte: now.date, lte: until }, status: { not: "cancelled" } }, select: { date: true, start: true, end: true, status: true } }),
  ]);
  const soon = { date: now.date, minutes: now.minutes + 60 };
  const slots = weeks
    .flatMap((w) => cal.freeSlots({ blocks: Array.isArray(w.blocks) ? w.blocks : [], appointments, slotMinutes: calendar.slotMinutes, now: soon }))
    .filter((x) => x.date <= until)
    .sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
  const picked = [];
  for (const date of [...new Set(slots.map((x) => x.date))]) {
    const day = slots.filter((x) => x.date === date);
    picked.push(day[0]);
    const later = day.find((x) => x.start >= Math.max(14 * 60, day[0].start + 120));
    if (later) picked.push(later);
  }
  return picked.slice(0, 6);
}

// The chat as the AI reads it (Telegram's away messages left out).
async function historyOf(chatId) {
  const rows = await prisma.tgMessage.findMany({ where: { chatId, deletedAt: null, auto: false }, orderBy: [{ sentAt: "desc" }, { id: "desc" }], take: HISTORY });
  return rows.reverse().map((m) => ({ id: m.id, from: m.out ? (m.ai ? "ai" : "operator") : "them", kind: m.kind, text: m.text, fileName: m.fileName }));
}

// ------------------------------------------------------------ sending

async function sendTelegram(chat, text) {
  const api = require("../telegram/api");
  const conn = await getSetting(inbox.CONNECTION_KEY, {});
  if (!conn.enabled || !conn.canReply) throw Object.assign(new Error("telegram_cannot_reply"), { code: "cannot_reply" });
  const params = { business_connection_id: chat.connectionId || conn.id, chat_id: Number(chat.tgUserId) };
  // "typing…", and a moment as long as a person would take to type it.
  await api.call("sendChatAction", { ...params, action: "typing" }).catch(() => {});
  await new Promise((r) => setTimeout(r, Math.min(6000, 1500 + text.length * 25)));
  const sent = await api.call("sendMessage", { ...params, text });
  return { tgMessageId: sent.message_id, sentAt: new Date((sent.date || Date.now() / 1000) * 1000) };
}

async function sendInstagram(chat, text) {
  const { extId } = await require("../igInbox").send(chat, text);
  return { extId, sentAt: new Date() };
}

async function send(chat, text) {
  const where = chat.platform === "instagram" ? await sendInstagram(chat, text) : await sendTelegram(chat, text);
  await inbox.record(chat, { kind: "text", text, out: true, ai: true, ...where });
}

// ------------------------------------------------------------ telling people

// The people who answer the firm's chats; nobody picked — the managers.
async function operatorIds() {
  const ids = await inbox.answererIds();
  if (ids.length) return ids;
  const managers = await prisma.user.findMany({ where: { active: true, role: { in: MANAGER_ROLES } }, select: { id: true } });
  return managers.map((u) => u.id);
}

const HANDOFF_WORDS = {
  urgent: "shoshilinch",
  angry: "norozi",
  existing_client: "mavjud mijoz",
  wants_person: "odam bilan gaplashmoqchi",
  payment: "toʻlov haqida soʻrayapti",
  voice_or_file: "ovozli xabar yoki fayl yubordi",
  insists_on_legal_answer: "yuridik javob talab qilyapti",
  blocked: "AI javobi tekshiruvdan oʻtmadi",
  send_failed: "AI javob yubora olmadi",
  other: "odam kerak",
};

async function tellOperators(chat, what, lead, note) {
  const app = require("../notify");
  const { notifyUser } = require("../telegram/notify");
  const f = require("../telegram/format");
  const name = lead?.name || inbox.displayName(chat);
  const where = chat.platform === "instagram" ? "Instagram" : "Telegram";
  const title = what === "agreed" ? `Konsultatsiyaga rozi boʻldi · ${name}` : `Mijoz sizni kutyapti · ${name}`;
  const lines = [
    what === "agreed" ? null : `AI toʻxtadi: ${HANDOFF_WORDS[note?.reason] || HANDOFF_WORDS.other}.`,
    lead?.problem ? `Masala: ${lead.problem}` : null,
    lead?.format || lead?.time ? `Konsultatsiya: ${[lead.format === "office" ? "ofisda" : lead.format === "online" ? "onlayn" : null, lead.time].filter(Boolean).join(", ")}` : null,
    lead?.phone || chat.phone ? `Telefon: ${lead?.phone || chat.phone}` : "Telefon hali yoʻq — yozishmada soʻrang.",
    note?.text ? `AI: ${note.text}` : null,
    `${where} orqali yozdi.`,
  ].filter(Boolean);
  const body = lines.join("\n");
  const link = `/telegram/${chat.id}`;
  for (const userId of await operatorIds()) {
    try {
      if (await app.notifyPush(userId, { kind: "leads", title, body, link, tag: `ai:${chat.id}:${what}` })) continue;
      await notifyUser(userId, "leads", [`${what === "agreed" ? "✅" : "🙋"} <b>${f.escapeHtml(title)}</b>`, f.escapeHtml(body), f.portalLink(link, "Yozishmani ochish")].join("\n"), undefined, { app: false });
    } catch (err) {
      console.error(`[ai-reply] telling user ${userId} failed:`, err.message);
    }
  }
}

// ------------------------------------------------------------ one chat

// Merge what it learnt with what it knew (empty answers keep the old).
function mergeLead(old, now) {
  const a = old && typeof old === "object" ? old : {};
  return Object.fromEntries(["name", "phone", "problem", "format", "time"].map((k) => [k, now[k] || a[k] || ""]));
}

async function handOver(chat, reason, text, lead) {
  await prisma.tgChat.update({ where: { id: chat.id }, data: { aiState: "handoff", aiNote: [HANDOFF_WORDS[reason] || HANDOFF_WORDS.other, text].filter(Boolean).join(" — ").slice(0, 300), aiAt: new Date() } });
  await tellOperators(chat, "handoff", lead, { reason, text });
  inbox.bumpInbox();
}

// Whether this chat is one for the AI now, and in which mode. -> mode or null
async function modeFor(chat, s, now = new Date()) {
  const mode = s[chat.platform];
  if (!mode || mode === "off") return null;
  const since = s.since?.[chat.platform];
  if (!since || chat.createdAt < new Date(since)) return null;
  if (chat.clientId || chat.hidden) return null;
  if (chat.aiState && !["on", "agreed"].includes(chat.aiState)) return null;
  if (chat.aiPausedUntil && chat.aiPausedUntil > now) return null;
  if (!chat.waitingSince || !chat.lastInAt) return null;
  if (now - chat.lastInAt < GATHER_MS || now - chat.lastInAt > WINDOW_MS) return null;
  const local = firmNow(now);
  if (mode === "offhours" && inHours(s, local.minutes)) return null;
  if (mode === "slow" && now - chat.waitingSince < s.slowMinutes * 60 * 1000) return null;
  // They wrote first: the firm writing first means people already know them.
  const first = await prisma.tgMessage.findFirst({ where: { chatId: chat.id, auto: false }, orderBy: [{ sentAt: "asc" }, { id: "asc" }], select: { out: true, ai: true } });
  if (!first || (first.out && !first.ai)) return null;
  return mode;
}

// Answer (or, in draft mode, suggest an answer for) one chat now.
// -> what happened: "sent" | "draft" | "handoff" | "agreed" | "done" | "skipped"
async function answer(chatId, { mode, now = new Date() } = {}) {
  const s = await settings();
  const chat = await prisma.tgChat.findUnique({ where: { id: chatId } });
  if (!chat) return "skipped";
  mode = mode || (await modeFor(chat, s, now));
  if (!mode) return "skipped";
  const messages = await historyOf(chat.id);
  const last = messages[messages.length - 1];
  if (!last || last.from !== "them") return "skipped";
  if (mode === "draft" && chat.aiDraftFor === last.id) return "skipped";

  // Its own cap, and no endless talk with one person.
  const usage = await usageNow();
  if (s.capUsd && usage.usd >= s.capUsd) return "skipped";
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (mode !== "draft" && (await prisma.tgMessage.count({ where: { chatId: chat.id, ai: true, sentAt: { gte: dayAgo } } })) >= MAX_PER_CHAT_DAY) {
    await handOver(chat, "other", "AI bu suhbatda koʻp yozdi", chat.aiLead);
    return "handoff";
  }

  const local = firmNow(now);
  const facts = factsOf(s);
  const system = P.system({ facts, rules: rulesOf(s), platform: chat.platform, now: local, workHours: { from: s.hoursFrom, to: s.hoursTo }, slots: await freeTimes(s, local) });
  const reply = await ask(s.model, { system, prompt: P.userPrompt(messages), schema: P.SCHEMA, maxTokens: 800 });
  await recordUsage(reply.usd);
  if (!reply.out) return "skipped";
  const out = P.clean(reply.out);
  const lead = mergeLead(chat.aiLead, out.lead);
  const data = { aiStage: out.stage, aiLead: lead, aiAt: now };
  // The number it picked out shows on the chat — only a claim: it never links
  // the chat to a client on its own (tgInbox.record); staff do, after checking.
  if (lead.phone && !chat.phone) {
    const phone = inbox.phoneIn(lead.phone);
    if (phone) Object.assign(data, { phone, phoneKey: require("../../lib/phone").phoneKey(phone) });
  }

  if (out.stage === "not_relevant" || (!out.reply && out.stage !== "handoff")) {
    await prisma.tgChat.update({ where: { id: chat.id }, data: { ...data, aiState: out.stage === "not_relevant" ? "done" : chat.aiState } });
    inbox.bumpInbox();
    return "done";
  }

  // The second look, by the cheap model.
  if (out.reply) {
    const check = await ask(/^claude-/.test(s.model) ? "claude-haiku-5-5" : s.model, { system: P.checkSystem(facts), prompt: P.checkPrompt(messages, out.reply), schema: P.CHECK_SCHEMA, maxTokens: 200 });
    await recordUsage(check.usd);
    if (check.out && check.out.ok === false) {
      await recordUsage(0, "blocked");
      console.warn(`[ai-reply] chat ${chat.id}: reply blocked (${check.out.problem})`);
      if (mode === "draft") {
        await prisma.tgChat.update({ where: { id: chat.id }, data: { ...data, aiDraft: null, aiDraftFor: last.id } });
        return "skipped";
      }
      await prisma.tgChat.update({ where: { id: chat.id }, data });
      await handOver({ ...chat, ...data }, "blocked", check.out.problem, lead);
      return "handoff";
    }
  }

  if (mode === "draft") {
    await prisma.tgChat.update({ where: { id: chat.id }, data: { ...data, aiDraft: out.reply || null, aiDraftFor: last.id } });
    await recordUsage(0, "drafts");
    inbox.bumpInbox();
    return "draft";
  }

  if (out.reply) {
    try {
      await send(chat, out.reply);
    } catch (err) {
      console.error(`[ai-reply] chat ${chat.id}: send failed: ${err.message}`);
      await prisma.tgChat.update({ where: { id: chat.id }, data });
      await handOver({ ...chat, ...data }, "send_failed", null, lead);
      return "handoff";
    }
    await recordUsage(0, "replies");
  }

  const fresh = { ...chat, ...data };
  if (out.stage === "handoff") {
    await prisma.tgChat.update({ where: { id: chat.id }, data });
    await handOver(fresh, out.handoff, out.handoffNote, lead);
    return "handoff";
  }
  if (out.stage === "agreed") {
    const before = chat.aiLead && typeof chat.aiLead === "object" ? chat.aiLead : {};
    // Told once — and again when their number comes after.
    const tell = chat.aiState !== "agreed" || (lead.phone && !before.phone);
    await prisma.tgChat.update({ where: { id: chat.id }, data: { ...data, aiState: "agreed", aiNote: out.handoffNote || null } });
    if (tell) await tellOperators(fresh, "agreed", lead, { text: out.handoffNote });
    inbox.bumpInbox();
    return "agreed";
  }
  await prisma.tgChat.update({ where: { id: chat.id }, data: { ...data, aiState: out.stage === "out_of_scope" ? "done" : chat.aiState === "agreed" ? "agreed" : "on" } });
  inbox.bumpInbox();
  return out.stage === "out_of_scope" ? "done" : "sent";
}

// ------------------------------------------------------------ the tick

const failures = new Map();

// Every 15 seconds (services/scheduler.js): the chats waiting for it.
async function tick(now = new Date()) {
  const s = await settings();
  const live = PLATFORMS.filter((p) => s[p] !== "off");
  if (!live.length) return 0;
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  if ((await prisma.tgMessage.count({ where: { ai: true, sentAt: { gte: hourAgo } } })) >= MAX_PER_HOUR) return 0;
  const todo = await prisma.tgChat.findMany({
    where: {
      platform: { in: live },
      clientId: null,
      hidden: false,
      waitingSince: { not: null },
      lastInAt: { lte: new Date(now.getTime() - GATHER_MS), gte: new Date(now.getTime() - WINDOW_MS) },
      OR: [{ aiState: null }, { aiState: { in: ["on", "agreed"] } }],
      AND: [{ OR: [{ aiPausedUntil: null }, { aiPausedUntil: { lt: now } }] }],
    },
    orderBy: { lastInAt: "asc" },
    take: 20,
  });
  let done = 0;
  for (const chat of todo) {
    if (done >= PER_TICK) break;
    const mode = await modeFor(chat, s, now);
    if (!mode) continue;
    if (mode === "draft" && chat.aiDraftFor) {
      const last = await prisma.tgMessage.findFirst({ where: { chatId: chat.id }, orderBy: [{ sentAt: "desc" }, { id: "desc" }], select: { id: true } });
      if (last?.id === chat.aiDraftFor) continue;
    }
    try {
      const result = await answer(chat.id, { mode, now });
      if (result !== "skipped") done += 1;
      failures.delete(chat.id);
    } catch (err) {
      console.error(`[ai-reply] chat ${chat.id}: ${err.message}`);
      // The key, the cap, the model busy: nothing wrong with the chat — next time.
      // The same chat failing again and again: a person takes it.
      const tries = (failures.get(chat.id) || 0) + 1;
      failures.set(chat.id, tries);
      if (tries >= 3) {
        failures.delete(chat.id);
        await handOver(chat, "send_failed", null, chat.aiLead).catch(() => {});
      }
      break;
    }
  }
  return done;
}

// ------------------------------------------------------------ staff

// Staff stop the AI in one chat, or give it back.
async function setChatAi(chatId, on) {
  const data = on ? { aiState: "on", aiPausedUntil: null, aiNote: null } : { aiState: "off", aiDraft: null };
  const chat = await prisma.tgChat.update({ where: { id: chatId }, data });
  inbox.bumpInbox();
  return chat;
}

// What the chat page shows about the AI.
function chatAi(c) {
  return {
    state: c.aiState,
    stage: c.aiStage,
    lead: c.aiLead && typeof c.aiLead === "object" ? c.aiLead : null,
    note: c.aiNote,
    at: c.aiAt,
    pausedUntil: c.aiPausedUntil,
    draft: c.aiDraft,
    draftFor: c.aiDraftFor,
  };
}

async function publicSettings() {
  const s = await settings();
  const calendars = await prisma.calendar.findMany({ where: { active: true }, select: { id: true, name: true, owner: { select: { role: true } } }, orderBy: { id: "asc" } });
  const tg = await getSetting(inbox.CONNECTION_KEY, {});
  return {
    ...s,
    defaultFacts: P.DEFAULT_FACTS,
    defaultRules: P.DEFAULT_RULES,
    modes: MODES,
    models: MODELS,
    calendars: calendars.map((c) => ({ id: c.id, name: c.name, boss: c.owner?.role === "BOSS" })),
    usage: await usageNow(),
    telegramCanReply: Boolean(tg.enabled && tg.canReply),
    instagramStatus: await require("../igInbox").status(),
  };
}

module.exports = { SETTINGS_KEY, MODES, MODELS, PLATFORMS, DEFAULTS, settings, saveSettings, publicSettings, freeTimes, modeFor, answer, tick, setChatAi, chatAi, usageNow, GATHER_MS };
