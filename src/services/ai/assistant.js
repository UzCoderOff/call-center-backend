const prisma = require("../../lib/prisma");
const { firmNow, firmDayRange } = require("../../lib/firmTime");
const live = require("../live");
const { aiSettings, apiKey, recordUsage } = require("./settings");
const { complete, OpenAiError } = require("./openai");
const tools = require("./tools");
const actions = require("./actions");

// Ledger AI (chat kind "assistant", services/chat.js): the boss and the
// developer ask in plain Uzbek or Russian; the model picks which of
// Ledger's own functions to call — lookups (tools.js) and, since 2026-10-14,
// a few actions (actions.js: reminders, tasks, next steps, targets, notes),
// each confirmed by the person before it runs — with the same access rules
// as the person asking, and writes the answer from what they return. It
// never makes up a number: every figure comes from a tool.

const MAX_ROUNDS = 6;
const HISTORY = 16;
const MAX_TOOL_RESULT = 14000; // characters of one tool's answer sent back

// "Bugun: 2026-10-17, soat 11:30 (Toshkent vaqti)." — read once per answer.
function nowLine() {
  const now = firmNow();
  return `Bugun: ${now.date}, soat ${String(Math.floor(now.minutes / 60)).padStart(2, "0")}:${String(now.minutes % 60).padStart(2, "0")} (Toshkent vaqti).`;
}

// `now`: the date and time line, or false to leave it out (Claude gets it
// as a separate system message after the question, so this prompt stays the
// same from one answer to the next).
function systemPrompt(user, { now = nowLine() } = {}) {
  const name = user.employee?.name || user.name || user.username;
  return [
    "Siz «Ledger AI» — yuridik firmaning ichki tizimi Ledgerdagi yordamchisiz.",
    `Siz bilan ${name} (${user.role === "BOSS" ? "firma rahbari" : "tizim dasturchisi"}) gaplashmoqda.`,
    ...(now ? [now] : []),
    "Qoidalar:",
    "- Foydalanuvchi qaysi tilda yozsa (oʻzbekcha lotin yoki ruscha), oʻsha tilda javob bering. Oʻzbekchada tabiiy, sodda, xushmuomala yozing.",
    "- Raqamlar, ismlar va faktlarni FAQAT vositalar (tools) natijasidan oling. Hech qachon taxmin qilmang va oʻylab topmang.",
    "- Kerakli maʼlumot vositalarda boʻlmasa yoki natija boʻsh boʻlsa, shuni ochiq ayting.",
    "- Davr aytilmagan boʻlsa, «bu oy» deb oling va javobda qaysi davr ekanini yozing.",
    "- Javob qisqa va aniq boʻlsin: avval asosiy raqam yoki xulosa, keyin kerak boʻlsa qisqa roʻyxat (har biri alohida qatorda). Markdown jadval ishlatmang.",
    "- Pulni soʻmda, minglik boʻsh joy bilan yozing (masalan, 12 500 000 soʻm).",
    ...TERMS,
    ...ACTION_RULES,
  ].join("\n");
}

// What the firm's words mean in the numbers (the model mixed them up,
// 2026-10-15).
const TERMS = [
  "- Konsultatsiya, kalendarga yozish (bron) va uchrashuv — bitta narsa: konsultatsiya kalendaridagi bekor qilinmagan yozuv, oʻz sanasi bilan sanaladi va uni yozgan xodimga hisoblanadi. «Keldi / kelmadi» — shu konsultatsiyalarning natijasi. Ularni alohida-alohida raqam deb koʻrsatmang.",
  "- Mijoz ishining «consultation» holati — «Murojaat» (shartnomagacha boʻlgan bosqich), u konsultatsiya boʻlib oʻtgani degani emas.",
  "- Voronkadagi «lost» — hech kim gaplasha olmagan raqamlar (javobsiz qoldi va qayta qoʻngʻiroqda ham ulanmadi), sababi yozilgan degani emas. Yangi raqam nega yozilmagani — outcomes (operator belgilagan sabab); konsultatsiyadan keyin nega davom etmagani — lostReasons.",
];

// What the model is told about doing things.
const ACTION_RULES = [
  "- Siz baʼzi ishlarni bajara olasiz: eslatma qoʻyish, xodimga vazifa berish, ochiq vazifani oʻzgartirish (nomi, izohi, muddati, kimga, javob kerakmi), mijozga keyingi qadam qoʻyish, oylik reja (target) qoʻyish, mijozga izoh yozish. Boshqa narsani oʻzgartira olmaysiz (oʻchirish, pul, shartnoma summasi, xodimlar va ruxsatlar — hech qachon) — soʻrashsa, Ledgerning qaysi sahifasida qilinishini ayting.",
  "- Siz tayyorlagan vazifa, eslatma, keyingi qadam va izohlarda muallif «Ledger AI» deb koʻrinadi (kim tasdiqlagani Ledgerda saqlanadi). Xodimdan biror narsani tushuntirish yoki hisobot soʻralsa, vazifani needs_answer bilan bering — xodim javobini Ledgerda yozadi, javoblarni tasks vositasida koʻrasiz.",
  "- Har bir ish avval tayyorlanadi (vosita chaqiriladi) va foydalanuvchiga «Tasdiqlash / Bekor qilish» kartochkasi chiqadi. Hech qachon «bajarildi» demang — faqat confirm_action natijasi «done» boʻlsa ayting.",
  "- confirm_action ni faqat foydalanuvchi aniq «ha / tasdiqlayman / mayli» degandan keyin chaqiring. Ikkilansa yoki oʻzgartirsa — cancel_action va yangisini tayyorlang.",
  "- Vaqtni doim Toshkent vaqti bilan «YYYY-MM-DD HH:MM» koʻrinishida bering. «Ertaga», «juma kuni» kabi soʻzlarni bugungi sanadan hisoblang. Vaqt aytilmasa 10:00 deb oling va buni ayting.",
  "- Mijoz kerak boʻlsa, avval search_clients bilan id sini toping. Ism bir nechta odamga mos kelsa — qaysi biri ekanini soʻrang.",
];

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
  // An action card keeps its id and where it stands, so "ha" in the next
  // message can confirm it (confirm_action).
  return rows.reverse().map((m) => {
    const action = m.data?.action;
    const content = action ? `[action_id=${m.id}, status=${action.status}] ${action.summary}` : m.text || "";
    return { role: m.authorId ? "user" : "assistant", content };
  });
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

// Every function this person's Ledger AI may call: lookups and actions.
const definitions = (user) => [...tools.definitions(user), ...actions.definitions(user)];

// One function call — an action is prepared in `conv` (the person's
// assistant chat), never run straight away.
function runTool(name, args, user, conv) {
  return actions.handles(name) ? actions.run(name, args, user, conv) : tools.run(name, args, user);
}

// Claude's turn (Sozlamalar → "Ledger AI chatida: Claude"): the same
// lookups and actions, through the Messages API. The chat so far goes as
// text; within one answer, Claude's own turns go back exactly as they came.
async function replyWithClaude(conv, user, settings) {
  const claude = require("./claude");
  if ((await askedToday(conv, user.id)) > settings.dailyLimit) {
    await post(conv, user, `Bugungi savollar chegarasi (${settings.dailyLimit} ta) tugadi. Ertaga yana soʻrang yoki dasturchi chegarani oshirsin.`);
    return;
  }
  // Claude's conversation starts with the person, and has no empty turns.
  const past = (await history(conv)).filter((m) => m.content && m.content.trim());
  while (past.length && past[0].role !== "user") past.shift();
  const messages = past.map((m) => ({ role: m.role, content: m.content }));
  // Within one answer every request repeats the earlier ones exactly: Claude
  // checks its own reasoning against them (a prompt rebuilt as the clock
  // turned 20:05 was refused, 2026-10-15). So the prompt, the tools and the
  // time are fixed here, once — the time on the question itself (every model
  // takes that), which also keeps the prompt cacheable between answers.
  const system = systemPrompt(user, { now: false });
  const last = messages[messages.length - 1];
  if (last?.role === "user") last.content = `${last.content}\n\n(${nowLine()})`;
  const toolDefs = definitions(user).map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters }));
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await claude.create({ system, tools: toolDefs, messages, output_config: { effort: "medium" } }, { feature: "chat" });
      if (response.stop_reason === "refusal") {
        await post(conv, user, "Bu savolga javob bera olmayman.");
        return;
      }
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "pause_turn") continue;
      const uses = response.content.filter((b) => b.type === "tool_use");
      if (uses.length === 0) {
        await post(conv, user, claude.textOf(response) || "Javob topa olmadim.");
        return;
      }
      const results = [];
      for (const use of uses) {
        let result;
        try {
          result = await runTool(use.name, use.input || {}, user, conv);
        } catch (err) {
          result = { error: err.message };
        }
        const text = JSON.stringify(result);
        results.push({ type: "tool_result", tool_use_id: use.id, content: text.length > MAX_TOOL_RESULT ? `${text.slice(0, MAX_TOOL_RESULT)}…(qisqartirildi)` : text });
      }
      messages.push({ role: "user", content: results });
    }
    await post(conv, user, "Savol juda murakkab boʻldi — iltimos, qismlarga boʻlib soʻrang.");
  } catch (err) {
    console.error(`[ai] ${user.username} (claude): ${err.message}`);
    await post(conv, user, claude.explain(err));
  }
}

// A question was just asked in `conv` by `user`: answer it.
async function reply(conv, user) {
  const settings = await aiSettings();
  if (settings.enabled && settings.provider === "claude" && settings.claudeKeyEnc) return replyWithClaude(conv, user, settings);
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
      const { message, usage: u } = await complete(key, { model: settings.model, messages, tools: definitions(user) });
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
          result = await runTool(call.function.name, args, user, conv);
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

module.exports = { reply, systemPrompt, definitions, runTool, ACTION_RULES, TERMS };
