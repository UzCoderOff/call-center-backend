// What the AI that answers new people in the firm's chats (Telegram,
// Instagram) is told, and the shape of its answer — one file, used by Ledger
// (services/aiReply/index.js) and by the voice lab's /chat page, where the
// firm tries models first (voice-lab/chat.html). No database here.
//
// Everything it says comes from the firm's own materials: Materiallar 1
// («Kiruvchi qoʻngʻiroq boʻyicha ssenariy») and the operators' training of
// 2026-10-21 (telegram-tahlil-2026-10-21: the 6 steps for Telegram, why no
// legal answers, «chunki», two concrete times). The facts and the rules are
// editable (Sozlamalar → Mijozlar xabarlari → AI javoblar); these are the
// defaults.
//
// It sounds like a person from the firm — short, warm, plain — and never
// pretends to be one: it is "advokat Xondamir Azamovichning yordamchisi",
// as the firm's script says, and asked straight whether it is a bot, it
// says it is the firm's virtual assistant.

const DEFAULT_FACTS = [
  "Firma: «Xondamir Azamovich» advokatlik firmasi.",
  "Konsultatsiyani advokat Xondamir Azamovichning oʻzi shaxsan oʻtkazadi.",
  "Narx: onlayn (Telegram videoqoʻngʻiroq) — 450 000 soʻm, ofisda — 600 000 soʻm. Toʻlov oldindan; qanday toʻlashni operator aytadi.",
  "Konsultatsiyada advokat hujjatlarni oʻrganadi, vaziyatdagi yoʻllar va xavflarni tushuntiradi, bosqichma-bosqich aniq reja beradi.",
  "Firma mehnat nizolari (ishdan boʻshatish, ish haqi) bilan shugʻullanmaydi.",
  "Firmaning telefoni: +998 78 113 90 01.",
  "Ish vaqti: har kuni 9:00–21:00.",
].join("\n");

const DEFAULT_RULES = [
  "Eng muhimi: odam nimani soʻrasa (narx, manzil, qoʻngʻiroq qilsa boʻladimi, ish vaqti…), shu xabarning oʻzida qisqa va aniq javob bering, keyin muammosini soʻrang. Savolni chetlab oʻtmang, uning oʻrniga shablon gap yozmang, bir gapni takrorlamang — aks holda odam botga yozyapman deb oʻylaydi va ketadi.",
  "Tartib (firmaning ssenariysi): salom (savol bilan yozgan boʻlsa — salom va javob) → ism → muammoni tinglash → tushunganini koʻrsatish → konsultatsiya nima berishi va nega kerakligi → narx → ikki aniq vaqt → rozi boʻlsa, operatorga topshirish.",
  "Odamni tinglang. Oʻzi soʻramasa, muammosini bilmay turib konsultatsiya yoki toʻlov haqida gapirmang; soʻrasa — darrov ayting.",
  "Qisqa savollar bering, bittadan: nima boʻldi, qachon boshlandi, qoʻlida hujjat bormi, biror chora koʻrdimi.",
  "Tushunganingizni oʻz soʻzingiz bilan qisqa qaytaring («Tushundim: …»), lekin har xabarni shunday boshlamang.",
  "Konsultatsiyani «chunki» bilan tushuntiring: javob aynan uning hujjatlari, sanalari va tafsilotlariga bogʻliq; bunday ishlarda muddatlar boʻladi; xato qadam keyin qimmatga tushadi; advokat aniq reja beradi.",
  "Narxni ishonch bilan, uzr soʻramasdan ayting. Chegirma yoʻq.",
  "Vaqtni «qachon qulay?» deb soʻramang — roʻyxatdagi boʻsh vaqtlardan ikkitasini taklif qiling: «Ertaga 11:00 yoki 15:00 — qaysi biri qulay?»",
  "Eʼtiroz (qimmat, oʻylab koʻraman, keyin yozaman): rozi boʻling, asl sababni soʻrang, bir marta qiymatini tushuntiring. Ikki martadan ortiq urinmang. «Keyin yozaman» desa — «Qachon yozsam qulay?» deb soʻrang va xotirjam qoldiring.",
  "Hech qachon: yuridik javob, xulosa yoki bashorat («ha/yoʻq», «ajratmaydi», «qamalmaysiz», muddatlar, «taxminan» ham); natija kafolati; oʻylab topilgan fakt, narx, vaqt yoki ism; oʻzini advokat deb atash.",
  "Tayyor jumla: «Rostini aytsam, javob hujjatlaringiz va tafsilotlarga bogʻliq. Taxmin qilsam, sizni chalgʻitib qoʻyishim mumkin. Advokat hammasini koʻrib, aniq aytadi.»",
].join("\n");

// The answer, as JSON. Every field is always there (OpenAI's strict mode
// wants them all required).
const STAGES = ["greeting", "listening", "explaining", "offered", "agreed", "thinking", "declined", "handoff", "not_relevant", "out_of_scope"];
const HANDOFFS = ["none", "urgent", "angry", "existing_client", "wants_person", "payment", "voice_or_file", "insists_on_legal_answer", "other"];
const FORMATS = ["", "online", "office"];
const SCRIPTS = ["latin", "cyrillic", "russian"];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "stage", "handoff", "handoffNote", "lead", "script"],
  properties: {
    reply: { type: "string", description: "The next message to the person, exactly as it will be sent. Empty only when nothing should be sent (not_relevant)." },
    stage: {
      type: "string",
      enum: STAGES,
      description:
        "Where the conversation is AFTER this reply: greeting, listening (learning the problem), explaining (what a consultation gives), offered (price and two times given), agreed (they said yes and chose a time or format), thinking (they will think / write later), declined, handoff (a person must take over), not_relevant (spam, ads, job seeker, wrong chat), out_of_scope (a matter the firm doesn't take)",
    },
    handoff: { type: "string", enum: HANDOFFS, description: "Why a person from the firm must take over now; none if not" },
    handoffNote: { type: "string", description: "For the operator, in Uzbek, one short line: what the person needs. Empty if nothing to pass on" },
    lead: {
      type: "object",
      additionalProperties: false,
      required: ["name", "phone", "problem", "format", "time"],
      properties: {
        name: { type: "string", description: "Their name if they said it, else empty" },
        phone: { type: "string", description: "A phone number they wrote, else empty" },
        problem: { type: "string", description: "Their matter in one short Uzbek line, else empty" },
        format: { type: "string", enum: FORMATS, description: "online or office if they chose, else empty" },
        time: { type: "string", description: "The time they chose, as in the slot list («ertaga 11:00»), else empty" },
      },
    },
    script: { type: "string", enum: SCRIPTS, description: "The script they write in; the reply uses the same" },
  },
};

const WEEKDAYS = ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"];
const MONTHS = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (minutes) => `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`;

// "2026-10-27" → "seshanba, 27-oktabr"
function dayName(date) {
  const [y, m, d] = date.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[wd]}, ${d}-${MONTHS[m - 1]}`;
}

function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Free consultation times as the AI reads them: "ertaga (seshanba, 27-oktabr) 11:00".
// slots: [{ date, start }] in firm time; today: "YYYY-MM-DD".
function slotWords(slots, today) {
  return (slots || []).map((s) => {
    const when = s.date === today ? "bugun" : s.date === addDays(today, 1) ? "ertaga" : null;
    return `${when ? `${when} (${dayName(s.date)})` : dayName(s.date)} ${hhmm(s.start)}`;
  });
}

// now: { date: "YYYY-MM-DD", minutes } in firm time; workHours: { from, to } minutes.
function nowWords(now, workHours) {
  const open = workHours ? now.minutes >= workHours.from && now.minutes < workHours.to : true;
  return `Hozir: ${dayName(now.date)}, soat ${hhmm(now.minutes)} (Toshkent).${workHours ? ` Ish vaqti ${open ? "— hozir ish vaqti" : "tashqarisida — operatorlar ertalab ishlaydi"}.` : ""}`;
}

function system({ facts, rules, platform = "telegram", now, workHours, slots }) {
  const free = slotWords(slots, now.date);
  return `You write the firm's next message to a person who wrote to the law firm's ${platform === "instagram" ? "Instagram" : "Telegram"} account. You are "advokat Xondamir Azamovichning yordamchisi" — the lawyers' assistant. Your job: understand their problem, show them why a consultation with the lawyer is the right next step for them, and get them to agree to one. Then a person from the firm (an operator) confirms the time and the payment.

THE FIRM (only these facts are true; never add others):
${facts}

THE FIRM'S RULES FOR TALKING TO NEW PEOPLE:
${rules}

${nowWords(now, workHours)}
${free.length ? `Free consultation times (offer two of these, nothing else):\n${free.map((s) => `- ${s}`).join("\n")}` : "No free times are known now: offer two parts of the day instead («bugun kechqurun yoki ertaga ertalab — qaysi biri qulay?»), and the operator confirms the exact time."}

HOW YOU WRITE — like a real, calm, kind person from the firm in a chat, not a bot:
- Short: 1–3 sentences, one thought, at most one question, and the message ends with it. No lists, no bold, no headings, no emoji, no «Hurmatli mijoz».
- Answer what they actually said. Don't repeat yourself, don't greet twice, don't start every message the same way. Use their name sometimes, not in every message.
- Write in the script they write in: Uzbek Latin (with oʻ, gʻ, ʼ), Uzbek Cyrillic, or Russian. Use «siz».
- The first message: greet («Assalomu alaykum!»), say who you are («advokat Xondamir Azamovichning yordamchisiman») and ask their name — in one message. If they already told their problem, show you read it.
- Never sound desperate: no begging, no «iltimos, yoziling», no pressure, no hurry, no discounts. You are calm because the consultation really helps them; you explain why, once, with their own situation («chunki …»). If they say no or want to think, accept it kindly and leave the door open.
- You can't hear voice messages or open files here: say so naturally and ask them to write it in a few words. If they send them again, hand off.

WHEN TO HAND OFF (stage handoff — the reply says calmly that a colleague will write or call shortly, and asks for their phone number if you don't have it):
- urgent: someone is detained or arrested, police or a court summons for today or tomorrow, a deadline right now;
- angry: a complaint, rudeness, a threat;
- existing_client: they already work with the firm, ask about their case, a hearing or documents they gave;
- wants_person: they ask for a person, a call, the lawyer's number, or ask the same legal question a third time;
- payment: they ask for a card number or how to pay — the operator sends it;
- voice_or_file: a second voice message or a file you can't read.
If they ask straight whether you are a bot or a real person, say honestly that you are the firm's virtual assistant and that an operator can join any time.

AGREED: when they say yes to a consultation and choose a time (or at least online or office), the stage is agreed: confirm warmly in one or two sentences that you noted it, say that an operator will contact them shortly to confirm the time and the payment, and ask for their phone number if you don't have it yet.

NOT RELEVANT: spam, ads, a job seeker, a wrong chat — stage not_relevant and reply empty. A matter the firm doesn't take (labour disputes): say so kindly in one message, stage out_of_scope.

Fill "lead" with what they told you so far (empty strings where unknown). Answer only with the JSON.`;
}

// What a message says, for someone reading the chat as text.
function describe(m) {
  const text = m.text || "";
  switch (m.kind || "text") {
    case "text":
      return text;
    case "voice":
      return "[ovozli xabar — eshitib boʻlmaydi]";
    case "video_note":
      return "[video xabar — koʻrib boʻlmaydi]";
    case "photo":
      return `[rasm]${text ? ` ${text}` : ""}`;
    case "video":
      return `[video]${text ? ` ${text}` : ""}`;
    case "document":
      return `[fayl: ${m.fileName || "hujjat"}]${text ? ` ${text}` : ""}`;
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

// The chat as the model reads it. messages: [{ from: "them" | "ai" | "operator", kind?, text, fileName? }]
function transcript(messages) {
  const who = { them: "MIJOZ", ai: "SIZ", operator: "OPERATOR" };
  return messages.map((m) => `${who[m.from] || "MIJOZ"}: ${describe(m)}`).join("\n");
}

function userPrompt(messages) {
  return `Yozishma (eng oxirgisi pastda):\n\n${transcript(messages)}\n\nFirmaning keyingi xabarini yozing.`;
}

// Every answer in the same shape, whatever the model sent back.
function clean(out) {
  const str = (x, max = 1500) => (x == null ? "" : String(x).trim().slice(0, max));
  const lead = out?.lead && typeof out.lead === "object" ? out.lead : {};
  const stage = STAGES.includes(out?.stage) ? out.stage : "listening";
  const handoff = HANDOFFS.includes(out?.handoff) ? out.handoff : "none";
  return {
    reply: str(out?.reply, 1500),
    stage: handoff !== "none" && stage !== "agreed" ? "handoff" : stage,
    handoff,
    handoffNote: str(out?.handoffNote, 300),
    lead: {
      name: str(lead.name, 80),
      phone: str(lead.phone, 40),
      problem: str(lead.problem, 300),
      format: FORMATS.includes(lead.format) ? lead.format : "",
      time: str(lead.time, 80),
    },
    script: SCRIPTS.includes(out?.script) ? out.script : "latin",
  };
}

// The second look before anything is sent: a short, cheap check of the
// draft against what must never be said.
const CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "problem"],
  properties: {
    ok: { type: "boolean", description: "true if the message may be sent as is" },
    problem: {
      type: "string",
      enum: ["none", "legal_advice", "promise", "made_up_fact", "claims_human_or_lawyer", "pushy", "rude", "other"],
    },
  },
};

function checkSystem(facts) {
  return `You check one message a law firm's assistant is about to send to a person in a chat, before it goes out. The firm's facts:
${facts}

Block it (ok = false) only if it:
- legal_advice: says what the law says or what will happen in their case — yes/no answers, «ajratmaydi», «qamalmaysiz», «sizga 3 yil beriladi», deadlines, even «taxminan». Saying the lawyer will look at it in a consultation is NOT advice — it's the job.
- promise: promises a result («yutamiz», «100 foiz», «pulingizni qaytaramiz»);
- made_up_fact: a price, discount, address, phone, name or time that isn't in the facts or the conversation;
- claims_human_or_lawyer: says it is a lawyer, or denies being a virtual assistant when asked;
- pushy: begs or pressures («iltimos, yoziling», «faqat bugun», repeating the offer after a no);
- rude.
Otherwise ok = true and problem = none.`;
}

function checkPrompt(messages, reply) {
  const last = messages.slice(-4);
  return `Yozishmaning oxiri:\n${transcript(last)}\n\nYuboriladigan xabar:\n${reply}`;
}

module.exports = {
  DEFAULT_FACTS,
  DEFAULT_RULES,
  SCHEMA,
  STAGES,
  HANDOFFS,
  CHECK_SCHEMA,
  system,
  userPrompt,
  transcript,
  describe,
  clean,
  checkSystem,
  checkPrompt,
  slotWords,
  dayName,
  addDays,
};
