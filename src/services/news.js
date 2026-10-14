const fs = require("fs");
const prisma = require("../lib/prisma");
const { firmNow, shiftDate } = require("../lib/firmTime");
const { isCoordinator } = require("../lib/jobs");
const { callsMatter } = require("../lib/calling");
const { notifyUser, linkedUsers, once } = require("./telegram/notify");

// "What's new" after a release (2026-10-14), told once to the people it
// concerns, on Telegram and in the app (kind "news"):
//   - the boss: one short summary of the whole release
//   - staff and lawyers: a line or two, only when it changes their work
//   - the developer: whether the release went in (kind "deploys", from the
//     server's auto-deploy log) — not the summary, they wrote it
// A release's notes are sent during working hours, within a few days of its
// date (someone connecting Telegram next month doesn't get old news).

const SEND_DAYS = 3;
const HOURS = { from: 9 * 60, to: 19 * 60 };

const isLawyerUser = (u) => u.role === "LAWYER";
const books = (u) => u.employee?.calendarAccess === "book";

// Newest first. `boss`: the summary (lines); `staff`: [{ to(user), text }] —
// each person gets the lines that apply to them, or nothing.
const NEWS = [
  {
    id: "2026-10-14-calendars",
    date: "2026-10-14",
    boss: [
      "Advokatlarning <b>shaxsiy kalendari</b>: har birining kuni — sud, uchrashuv, ish; ishlaridagi sud sanalari va konsultatsiyalar ham koʻrinadi. Kalendar → «Advokatlar kuni»: hammasi bir joyda.",
      "<b>Konsultatsiya kalendari</b> yangilandi: boʻsh vaqtlar ixcham, kunni bir bosishda oʻzgartirish. Advokat uni oʻzi yoqib-oʻchira oladi.",
      "Bitta ishga <b>bir nechta advokat</b> biriktirish mumkin.",
      "<b>Mijozlar</b>: ish olib borilayotgan mijozlar birinchi; mijoz sahifasida umumiy pul holati — qancha berdi, qancha qoldi, keyingi toʻlov.",
      "<b>Qoʻngʻiroqlar</b> faqat call-markaz va koordinatorlarniki hisoblanadi. Haftalik hisobotdagi qoʻngʻiroq raqamlari taxminiy — IP-telefoniya ulanguncha.",
    ],
    staff: [
      {
        to: isLawyerUser,
        text: "Endi sizning <b>shaxsiy kalendaringiz</b> bor: Kalendar → «Mening kunim». Sud, uchrashuv va ishlaringizni yozing; ishlaringizdagi sud sanalari va konsultatsiyalar ham shu yerda.",
      },
      {
        to: (u) => isLawyerUser(u) && u.calendar,
        text: "Konsultatsiya qabul qilmaydigan kunlaringizni bir bosishda belgilang («Bu kun»). Umuman qabul qilmasangiz — konsultatsiya kalendarini oʻchirib qoʻyishingiz mumkin.",
      },
      { to: isLawyerUser, text: "Bitta ishda bir nechta advokat boʻlishi mumkin — sizni ishga qoʻshishsa, xabar keladi." },
      { to: (u) => !isLawyerUser(u) && books(u), text: "Konsultatsiya kalendari yangilandi: boʻsh vaqtlar endi tugmachalar — vaqtni bosing va mijozni yozing." },
      { to: (u) => isCoordinator(u.employee), text: "Mijozlar boʻlimida ish olib borilayotgan mijozlaringiz birinchi; mijoz sahifasida umumiy toʻlov holati — qancha berdi, qancha qoldi." },
      {
        to: (u) => u.employee?.collectCalls && !callsMatter(u.employee),
        text: "Telefoningizdagi qoʻngʻiroqlar endi Ledger'ga yuborilmaydi — faqat call-markaz va koordinatorlarning qoʻngʻiroqlari hisoblanadi.",
      },
    ],
  },
];

// The message for one person, or null.
function messageFor(news, user) {
  if (user.role === "DEVELOPER") return null;
  const lines = user.role === "BOSS" ? news.boss : news.staff.filter((s) => s.text && s.to(user)).map((s) => s.text);
  if (!lines.length) return null;
  return ["🆕 <b>Ledger yangilandi</b>", ...lines.map((l) => `• ${l}`)].join("\n");
}

async function newsTick(now = firmNow()) {
  if (now.minutes < HOURS.from || now.minutes > HOURS.to) return 0;
  const current = NEWS.filter((n) => n.date <= now.date && now.date <= shiftDate(n.date, SEND_DAYS));
  if (!current.length) return 0;
  let sent = 0;
  const users = await linkedUsers();
  for (const news of current) {
    for (const user of users) {
      const text = messageFor(news, user);
      if (!text) continue;
      if (await once(`news:${news.id}:${user.id}`, () => notifyUser(user, "news", text))) sent += 1;
    }
  }
  return sent;
}

// ------------------------------------------------------------ releases
// The server's auto-deploy (~/autodeploy/watch.sh, see DEPLOY.md) logs each
// release it tries: "YYYY-MM-DD HH:MM:SS  OK deployed abc1234 — subject",
// "…  !! FAILED abc1234 (exit 1). Now running: …", "…  !! HELD abc1234 — why".
// Each one, while recent, goes to the developer once. The old version is
// still running after a failed or held one, so it can tell.
const DEPLOY_LOG = process.env.AUTODEPLOY_LOG || "/home/ubuntu/autodeploy/autodeploy.log";
const RECENT_MS = 30 * 60 * 1000;
const LINE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(OK deployed|!! FAILED|!! HELD)\s+([0-9a-f]{7,40})\b\s*(?:—\s*)?(.*)$/;

function readTail(file, bytes = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The recent releases in a log's text: [{ at, kind: "ok"|"failed"|"held", sha, text }].
function parseDeployLog(text, nowMs = Date.now()) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const m = LINE.exec(line.trim());
    if (!m) continue;
    const at = new Date(m[1].replace(" ", "T")).getTime();
    if (!Number.isFinite(at) || nowMs - at > RECENT_MS || at - nowMs > 60 * 1000) continue;
    out.push({ at, kind: m[2] === "OK deployed" ? "ok" : m[2] === "!! FAILED" ? "failed" : "held", sha: m[3].slice(0, 7), text: m[4].trim() });
  }
  return out;
}

const escape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function deployMessage(d) {
  if (d.kind === "ok") return `✅ <b>Yangi versiya oʻrnatildi</b>: ${d.sha}\n${escape(d.text)}`;
  if (d.kind === "held") return `⏸ <b>Yangi versiya ushlab turildi</b>: ${d.sha} — server eski versiyada.\n${escape(d.text)}`;
  return `❌ <b>Yangi versiya oʻrnatilmadi</b>: ${d.sha}\n${escape(d.text)}\nServerdagi ~/autodeploy/autodeploy.log ni koʻring.`;
}

async function deployTick(file = DEPLOY_LOG) {
  const text = readTail(file);
  if (!text) return 0;
  const releases = parseDeployLog(text);
  if (!releases.length) return 0;
  const developers = await prisma.user.findMany({ where: { role: "DEVELOPER", active: true }, select: { id: true } });
  let sent = 0;
  for (const d of releases) {
    for (const dev of developers) {
      if (await once(`deploy:${d.kind}:${d.sha}:${dev.id}`, () => notifyUser(dev.id, "deploys", deployMessage(d)))) sent += 1;
    }
  }
  return sent;
}

module.exports = { NEWS, messageFor, newsTick, parseDeployLog, deployMessage, deployTick };
