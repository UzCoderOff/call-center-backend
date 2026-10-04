const prisma = require("../../lib/prisma");
const { firmNow, firmDayRange } = require("../../lib/firmTime");
const live = require("../live");
const { aiSettings, apiKey, recordUsage } = require("./settings");
const { complete, OpenAiError } = require("./openai");
const tools = require("./tools");

// Ledger AI (chat kind "assistant", services/chat.js): the boss and the
// developer ask in plain Uzbek or Russian; the model picks which of
// Ledger's own read-only functions to call (tools.js — the same access
// rules as the person asking) and writes the answer from what they return.
// It never makes up a number: every figure comes from a tool.

const MAX_ROUNDS = 6;
const HISTORY = 16;
const MAX_TOOL_RESULT = 14000; // characters of one tool's answer sent back

function systemPrompt(user) {
  const now = firmNow();
  const name = user.employee?.name || user.name || user.username;
  return [
    "Siz «Ledger AI» — yuridik firmaning ichki tizimi Ledgerdagi yordamchisiz.",
    `Siz bilan ${name} (${user.role === "BOSS" ? "firma rahbari" : "tizim dasturchisi"}) gaplashmoqda.`,
    `Bugun: ${now.date}, soat ${String(Math.floor(now.minutes / 60)).padStart(2, "0")}:${String(now.minutes % 60).padStart(2, "0")} (Toshkent vaqti).`,
    "Qoidalar:",
    "- Foydalanuvchi qaysi tilda yozsa (oʻzbekcha lotin yoki ruscha), oʻsha tilda javob bering. Oʻzbekchada tabiiy, sodda, xushmuomala yozing.",
    "- Raqamlar, ismlar va faktlarni FAQAT vositalar (tools) natijasidan oling. Hech qachon taxmin qilmang va oʻylab topmang.",
    "- Kerakli maʼlumot vositalarda boʻlmasa yoki natija boʻsh boʻlsa, shuni ochiq ayting.",
    "- Davr aytilmagan boʻlsa, «bu oy» deb oling va javobda qaysi davr ekanini yozing.",
    "- Javob qisqa va aniq boʻlsin: avval asosiy raqam yoki xulosa, keyin kerak boʻlsa qisqa roʻyxat (har biri alohida qatorda). Markdown jadval ishlatmang.",
    "- Pulni soʻmda, minglik boʻsh joy bilan yozing (masalan, 12 500 000 soʻm).",
    "- Siz faqat oʻqiysiz: hech narsani oʻzgartira olmaysiz. Shuni soʻrashsa, Ledgerning qaysi sahifasida qilish mumkinligini ayting.",
  ].join("\n");
}

// Saves Ledger AI's answer in the chat and tells their screens and phone.
async function post(conv, owner, text) {
  const message = await prisma.message.create({ data: { conversationId: conv.id, authorId: null, text: text.slice(0, 4000) } });
  await prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: message.createdAt } });
  live.bump([owner.id]);
  const member = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: conv.id, userId: owner.id } } });
  // They asked a moment ago and are most likely still looking: no buzz.
  const reading = member?.readAt && Date.now() - member.readAt.getTime() < 90 * 1000;
  if (!reading) {
    await require("../notify")
      .notifyPush(owner.id, { kind: "chat", title: "Ledger AI", body: text.replace(/\*\*/g, "").slice(0, 300), link: `/chat/${conv.id}`, tag: `chat:${conv.id}` })
      .catch(() => {});
  }
  return message;
}

// Questions asked today (the firm's day) — for the daily limit.
async function askedToday(conv, userId) {
  const startOfDay = new Date(firmDayRange(firmNow().date).from);
  return prisma.message.count({ where: { conversationId: conv.id, authorId: userId, createdAt: { gte: startOfDay } } });
}

// The chat so far, as the model's messages (oldest first).
async function history(conv) {
  const rows = await prisma.message.findMany({
    where: { conversationId: conv.id, deletedAt: null },
    orderBy: { id: "desc" },
    take: HISTORY,
  });
  return rows.reverse().map((m) => ({ role: m.authorId ? "user" : "assistant", content: m.text || "" }));
}

function explain(err) {
  if (err instanceof OpenAiError) {
    if (err.status === 401) return "OpenAI kaliti notoʻgʻri yoki oʻchirilgan. Sozlamalar → Sunʼiy intellekt boʻlimida yangisini kiriting.";
    if (err.status === 429 && /quota|billing/i.test(`${err.code} ${err.message}`)) return "OpenAI hisobidagi mablagʻ tugagan — platform.openai.com da toʻldiring.";
    if (err.status === 429) return "OpenAI hozir band — bir daqiqadan soʻng qayta soʻrang.";
    if (err.status === 404 || err.code === "model_not_found") return "Tanlangan model bu kalit bilan ishlamaydi — Sozlamalar → Sunʼiy intellekt boʻlimida boshqasini tanlang.";
  }
  return "Hozir javob bera olmadim. Birozdan soʻng qayta urinib koʻring.";
}

// A question was just asked in `conv` by `user`: answer it.
async function reply(conv, user) {
  const settings = await aiSettings();
  const key = await apiKey();
  if (!settings.enabled || !key) {
    await post(conv, user, "Ledger AI hali yoqilmagan: dasturchi Sozlamalar → Sunʼiy intellekt boʻlimida OpenAI kalitini kiritishi kerak.");
    return;
  }
  if ((await askedToday(conv, user.id)) > settings.dailyLimit) {
    await post(conv, user, `Bugungi savollar chegarasi (${settings.dailyLimit} ta) tugadi. Ertaga yana soʻrang yoki dasturchi chegarani oshirsin.`);
    return;
  }

  const messages = [{ role: "system", content: systemPrompt(user) }, ...(await history(conv))];
  const usage = { input: 0, output: 0 };
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const { message, usage: u } = await complete(key, { model: settings.model, messages, tools: tools.definitions(user) });
      usage.input += u?.prompt_tokens || 0;
      usage.output += u?.completion_tokens || 0;
      const calls = message.tool_calls || [];
      if (calls.length === 0) {
        await post(conv, user, (message.content || "").trim() || "Javob topa olmadim.");
        return;
      }
      messages.push({ role: "assistant", content: message.content || null, tool_calls: calls });
      for (const call of calls) {
        let result;
        try {
          const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          result = await tools.run(call.function.name, args, user);
        } catch (err) {
          result = { error: err.message };
        }
        const text = JSON.stringify(result);
        messages.push({ role: "tool", tool_call_id: call.id, content: text.length > MAX_TOOL_RESULT ? `${text.slice(0, MAX_TOOL_RESULT)}…(qisqartirildi)` : text });
      }
    }
    await post(conv, user, "Savol juda murakkab boʻldi — iltimos, qismlarga boʻlib soʻrang.");
  } catch (err) {
    console.error(`[ai] ${user.username}: ${err.message}`);
    await post(conv, user, explain(err));
  } finally {
    console.log(`[ai] ${user.username}: ${usage.input} in / ${usage.output} out tokens (${settings.model})`);
    await recordUsage(firmNow().date.slice(0, 7), usage).catch(() => {});
  }
}

module.exports = { reply, systemPrompt };
