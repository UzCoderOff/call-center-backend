const fs = require("fs");
const prisma = require("../lib/prisma");
const { firmNow, shiftDate } = require("../lib/firmTime");
const { isCoordinator, isCallCenter } = require("../lib/jobs");
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
    id: "2026-10-15-telegram-inbox",
    date: "2026-10-15",
    boss: [
      "<b>Mijozlar Telegrami</b> (menyuda alohida boʻlim): firma Telegram akkauntiga yozganlarning xabarlari Ledger'da. Yangi odamlar va shartnomasiz mijozlar — operatorlarda; ishdagi mijozlar — koordinatorida (mijozi yozsa, unga xabar keladi). Mijoz sahifasida uning Telegrami koʻrinadi. Javob hozircha Telegram ilovasidan yoziladi.",
      "<b>AI tahlili (beta)</b>: yozishma tinchigach AI uni oʻqiydi — firma ishiga tegishlimi (spam yashiriladi), mijoz yozildimi yoki yoʻqotildimi, operator qanday ishladi va keyingi safar nima qilish kerak. Natijalar sahifasida. Beta — xato qilishi mumkin, toʻliq ishonmang. AI mijozga hech narsa yozmaydi.",
      "Firma Telegramini ulash va operatorlar qoidalarini yozish: Sozlamalar → «Mijozlar Telegrami».",
    ],
    staff: [
      {
        to: (u) => u.role === "EMPLOYEE" && isCallCenter(u.employee),
        text: "Firma Telegramiga yozganlar endi Ledger'da ham: menyuda «Mijozlar Telegrami». Kim kutayotgani, yozishma qaysi mijozniki — bir joyda; yangi odamni mijoz qilib qoʻshish yoki mavjud mijozga bogʻlash mumkin. Ishdagi mijozga bogʻlansa, yozishma koordinatorga oʻtadi. Javobni hozircha odatdagidek Telegram ilovasidan yozasiz.",
      },
      {
        to: (u) => u.role === "EMPLOYEE" && isCoordinator(u.employee),
        text: "Mijozingiz firma Telegramiga yozsa — sizga xabar keladi, yozishma esa menyudagi «Mijozlar Telegrami»da va mijoz sahifasida koʻrinadi.",
      },
    ],
  },
  {
    id: "2026-10-15-office-calls-cash",
    date: "2026-10-15",
    boss: [
      "<b>Ofis xodimlarining qoʻngʻiroqlari</b> yana koʻrinadi: oʻzlariga — «Qoʻngʻiroqlar» va Asosiy sahifada; sizga — «Ofis xodimlari» tugmasi bilan (odatda oʻchiq). Ular rejaga, Natijalarga va jarimalarga hisoblanmaydi.",
      "<b>Kassa</b>: naqd toʻlov yozilganda «Naqd pulni kim oldi?» deb soʻraladi — xodimning oʻzi, siz yoki advokat. Notoʻgʻri yozilganlarini Moliya → Kassa → «Kimda?» dan toʻgʻrilang. Advokat olgan naqd Kassada advokatda turadi, undan qabul qilguningizcha.",
      "<b>Pul kiritish</b> osonroq: mijoz sahifasining tepasida «Toʻlov» va «Shartnoma summasi»; Moliya sahifasida «Toʻlov qoʻshish» — mijozni ismi yoki raqami bilan topasiz.",
      "<b>Mijoz sahifasi — ish loyihasi kabi</b>: ish shu yerning oʻzida ochiq — jamoa (advokatlar va koordinator), keyingi sana, qarz, ochiq vazifalar, ishning yoʻli, Hujjatlar, Pul va Tarix, hammasi bir sahifada. Jamoa mijozning chatida gaplashadi (@ bilan hamkasbni eslatish).",
      "<b>Tarix</b> endi turli yozuvlar bilan: sud majlisi (natija va keyingi sana), hujjat topshirildi, qaror (muddati bilan), uchrashuv. Majlis oʻtgach Ledger advokatdan «Qanday oʻtdi?» deb soʻraydi — javob ish tarixiga, kalendarga va jamoaga boradi.",
      "<b>Kalendar</b>: «Kim boʻsh?» — advokatlar birga boʻsh vaqtni topadi; takrorlanadigan yozuvlar; majlisdan bir kun oldin va ertalab eslatma. Advokat yoʻq boʻlsa — «Oʻrinbosar» uning ishlariga qaraydi.",
      "Sozlamalarda: <b>ish andozalari</b> (tayyor vazifalar roʻyxati) va <b>qarordan keyingi muddatlar</b> — kunlarni advokatlaringiz kiritadi.",
    ],
    staff: [
      {
        to: (u) => u.employee?.collectCalls && !callsMatter(u.employee),
        text: "Qoʻngʻiroqlaringiz yana Ledger'da: «Qoʻngʻiroqlar» boʻlimida va Asosiy sahifada. Ledger ilovasini bir marta oching — telefon ularni yana yuboradi.",
      },
      {
        to: isLawyerUser,
        text: "Mijozni ochsangiz, ishi shu yerda: vazifalar, hujjatlar, pul va tarix bir sahifada; jamoa mijozning chatida gaplashadi (@ bilan eslatish). Majlis oʻtgach «Qanday oʻtdi?» — natija va keyingi sana bitta joyda yoziladi. Kalendarda «Kim boʻsh?» va «Oʻrinbosar».",
      },
      {
        to: (u) => isCoordinator(u.employee),
        text: "Yangi «Qarzlar» boʻlimi: kim kechikkan, kim bu hafta toʻlashi kerak — qoʻngʻiroq tugmasi va izoh bilan. Mijoz sahifasida ish endi toʻliq ochiq: vazifalar, pul va tarix bir joyda.",
      },
      {
        to: (u) => !isLawyerUser(u) && (books(u) || isCoordinator(u.employee)),
        text: "Naqd toʻlov yozganda endi «Naqd pulni kim oldi?» soʻraladi: pulni oʻzingiz olgan boʻlsangiz — «Men oldim»; mijoz ofisda rahbarga yoki advokatga bergan boʻlsa — oʻshani tanlang.",
      },
    ],
  },
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
