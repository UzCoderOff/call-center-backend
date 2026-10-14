const fs = require("fs");
const path = require("path");
const { unzipSync, strFromU8 } = require("fflate");
const prisma = require("../../lib/prisma");
const env = require("../../config/env");
const { firmNow } = require("../../lib/firmTime");
const { getSetting, setSetting } = require("../../lib/settings");
const cl = require("../clients");
const claude = require("./claude");

// Claude reads a client's file (2026-10-14) — a court decision, an
// indictment, an application, a contract: what it is, a summary, the text
// for the case's "Ishning mohiyati va tafsilotlari", who's in it, the dates
// that matter (hearings, deadlines, investigation steps), the stage it
// shows, risks and next steps. Nothing is saved on the case by itself: the
// client page offers each part to add (one tap each). The reading is kept on
// the file, so the same file isn't paid for twice.
//
// PDFs and pictures go to Claude as they are; Word files (.docx) and text
// as their text. Up to MAX_BYTES; a person reads at most DAILY_PER_PERSON a day.

const MAX_BYTES = 20 * 1024 * 1024;
const DAILY_PER_PERSON = 15;
const IMAGES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

class ReaderError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const DATE_KIND_NAMES = cl.DATE_KINDS;
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["documentType", "summary", "details", "parties", "keyDates", "stage", "risks", "nextSteps"],
  properties: {
    documentType: { type: "string" },
    summary: { type: "string" },
    details: { type: "string" },
    parties: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["name", "role"], properties: { name: { type: "string" }, role: { type: "string" } } },
    },
    keyDates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "date", "time", "title", "place"],
        properties: {
          kind: { type: "string", enum: DATE_KIND_NAMES },
          date: { type: "string", format: "date" },
          time: { anyOf: [{ type: "string" }, { type: "null" }] },
          title: { type: "string" },
          place: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
    },
    stage: {
      anyOf: [
        { type: "null" },
        { type: "object", additionalProperties: false, required: ["stage", "date"], properties: { stage: { type: "string", enum: cl.LEGAL_STAGES }, date: { type: "string", format: "date" } } },
      ],
    },
    risks: { type: "array", items: { type: "string" } },
    nextSteps: { type: "array", items: { type: "string" } },
  },
};

const SYSTEM = [
  "Siz Oʻzbekistondagi yuridik firmaning advokat yordamchisisiz. Sizga mijozning ishiga oid hujjat beriladi (sud qarori, ayblov xulosasi, chaqiruv, ariza, shartnoma va hokazo).",
  "Hujjatni diqqat bilan oʻqing va JSON qaytaring:",
  "- documentType: hujjat turi, qisqa (masalan, «Birinchi instansiya sudining hal qiluv qarori»).",
  "- summary: 2–4 jumlada hujjat nima haqida va nima qaror/talab qilingan.",
  "- details: ishning mohiyati va tafsilotlari — mijoz ishining kartochkasiga yoziladigan matn: nima boʻlgan, tomonlar, asosiy faktlar, summalar, moddalar (agar boʻlsa). 5–12 jumla.",
  "- parties: hujjatdagi tomonlar va ularning roli (daʼvogar, javobgar, gumon qilinuvchi, tergovchi, sudya va hokazo).",
  "- keyDates: hujjatda koʻrsatilgan MUHIM sanalar — sud majlislari, tergov harakatlari, chaqiruvlar, shikoyat muddatlari. Sanani hujjatda yozilganidek aniq oling (YYYY-MM-DD); vaqt boʻlsa «HH:MM». Hujjatda yoʻq sanani oʻylab topmang. Shikoyat muddati faqat hujjatda yozilgan boʻlsa (masalan, «qaror … kun ichida shikoyat qilinishi mumkin» va qaror sanasi aniq boʻlsa) hisoblang va title da shuni ayting.",
  "- stage: hujjat ishning qaysi bosqichini koʻrsatadi (va qaysi sanadan) — aniq boʻlmasa null.",
  "- risks: mijoz uchun xavflar yoki eʼtibor berish kerak boʻlgan joylar (2–5 ta, qisqa).",
  "- nextSteps: advokat/koordinator nima qilishi kerak (2–5 ta, qisqa).",
  "Hamma matnni oʻzbek tilida, lotin yozuvida yozing. Hujjat oʻqib boʻlmasa yoki yuridik hujjat boʻlmasa — summary da shuni ayting, qolganlarini boʻsh qoldiring.",
].join("\n");

// A Word file's text: its paragraphs, in order.
function docxText(buffer) {
  const files = unzipSync(new Uint8Array(buffer), { filter: (f) => f.name === "word/document.xml" });
  const xml = files["word/document.xml"];
  if (!xml) throw new ReaderError("unreadable");
  return strFromU8(xml)
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The file as Claude content blocks.
function contentOf(file) {
  const abs = path.join(env.clientFilesDir, file.path);
  if (!fs.existsSync(abs)) throw new ReaderError("file_missing", 404);
  const size = fs.statSync(abs).size;
  if (size > MAX_BYTES) throw new ReaderError("too_large", 413);
  const ext = path.extname(file.name).toLowerCase();
  const data = fs.readFileSync(abs);
  if (ext === ".pdf") return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") } }];
  if (IMAGES[ext]) return [{ type: "image", source: { type: "base64", media_type: IMAGES[ext], data: data.toString("base64") } }];
  if (ext === ".docx") return [{ type: "text", text: `Hujjat matni (${file.name}):\n\n${docxText(data).slice(0, 400000)}` }];
  if (ext === ".txt") return [{ type: "text", text: `Hujjat matni (${file.name}):\n\n${data.toString("utf8").slice(0, 400000)}` }];
  throw new ReaderError("unsupported", 415);
}

const readable = (name) => [".pdf", ".docx", ".txt", ...Object.keys(IMAGES)].includes(path.extname(name || "").toLowerCase());

// One person's reads today (the daily cap).
async function countRead(userId) {
  const today = firmNow().date;
  const all = await getSetting("aiFileReads", {});
  const day = { ...(all[today] || {}) };
  if ((day[userId] || 0) >= DAILY_PER_PERSON) throw new ReaderError("daily_limit", 429);
  day[userId] = (day[userId] || 0) + 1;
  await setSetting("aiFileReads", { [today]: day }, null);
}

// Reads `file` (a ClientFile row) for `user`; `again`: read it anew even if
// it was read before. -> the reading.
async function analyze(file, user, { again = false } = {}) {
  if (file.aiAnalysis && !again) return file.aiAnalysis;
  if (!readable(file.name)) throw new ReaderError("unsupported", 415);
  const content = contentOf(file);
  await countRead(user.id);
  const kase = file.caseId ? await prisma.clientCase.findUnique({ where: { id: file.caseId }, select: { matter: true, details: true, legalStage: true } }) : null;
  const context = kase ? `Bu hujjat quyidagi ishga tegishli: «${kase.matter || "masala koʻrsatilmagan"}». Hozirgi bosqich: ${kase.legalStage || "—"}. Ishning hozirgi tafsilotlari: ${kase.details || "—"}.\nBugun: ${firmNow().date}.` : `Bugun: ${firmNow().date}.`;
  const response = await claude.create(
    {
      system: SYSTEM,
      messages: [{ role: "user", content: [...content, { type: "text", text: `${context}\n\nShu hujjatni oʻqib, JSON qaytaring.` }] }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    },
    { feature: "fileReader" }
  );
  const reading = claude.jsonOf(response);
  if (!reading) throw new ReaderError(response.stop_reason === "refusal" ? "declined" : "unreadable", 422);
  // Only kinds and stages Ledger knows; dates that are real dates.
  reading.keyDates = (reading.keyDates || []).filter((d) => cl.DATE_KINDS.includes(d.kind) && /^\d{4}-\d{2}-\d{2}$/.test(d.date)).slice(0, 20);
  if (reading.stage && (!cl.LEGAL_STAGES.includes(reading.stage.stage) || !/^\d{4}-\d{2}-\d{2}$/.test(reading.stage.date))) reading.stage = null;
  const saved = { ...reading, model: response.model, at: new Date().toISOString(), byUserId: user.id };
  await prisma.clientFile.update({ where: { id: file.id }, data: { aiAnalysis: saved, aiAnalyzedAt: new Date() } });
  return saved;
}

module.exports = { analyze, readable, docxText, ReaderError, SCHEMA, DAILY_PER_PERSON };
