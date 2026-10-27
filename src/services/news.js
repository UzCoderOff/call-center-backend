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
    id: "2026-10-27-ring-own-caller-after-call",
    date: "2026-10-27",
    boss: [
      "<b>Qoʻngʻiroq uzoqroq jiringlaydi</b>: har bir telefon 30 soniya (avval 20 — uxlab yotgan telefon uygʻonguncha vaqt ketib, operatorga atigi 12–18 soniya qolardi). Ilova 3.2.3 telefon «tebranish» rejimida ham titraydi — avval bunday telefonda qoʻngʻiroq umuman sezilmasdi.",
      "<b>Mijoz oʻz odamiga</b>: kimdir gaplashgan raqam qayta qoʻngʻiroq qilsa, avval oʻsha odamga ulanadi; 30 soniyada olmasa — navbatdagi operatorga.",
      "<b>Javob berildimi?</b> Telefoni jiringlab, olmagan har kim Ledgerdan biladi: «Shaxodat javob berdi — qayta qoʻngʻiroq shart emas» yoki «hech kim javob bermadi». Javobsiz qoʻngʻiroqlar roʻyxatida ham kim gaplashgani yoki «Hali hech kim gaplashmadi» yoziladi.",
      "<b>Qoʻngʻiroq natijasi majburiy</b>: operator yangi raqam bilan gaplashib, konsultatsiyaga yozmagan boʻlsa, Ledger «nima boʻldi?» deb soʻraydi va javob bermaguncha boshqa ish qildirmaydi (ilova 3.2.4 qoʻngʻiroq tugashi bilan oʻzi ochadi). Bugundan keyingi qoʻngʻiroqlar uchun — eskilari bosh sahifadagi roʻyxatda qoladi.",
    ],
    staff: [
      {
        to: (u) => u.role === "EMPLOYEE" && isCallCenter(u.employee),
        text: "Qoʻngʻiroq endi 30 soniya jiringlaydi. Siz bilan gaplashgan mijoz qayta qoʻngʻiroq qilsa, avval sizga ulanadi. Telefoningiz jiringlab, siz olmagan boʻlsangiz, Ledger kim javob berganini yoki hech kim javob bermaganini aytadi. Yangi raqam bilan gaplashgach, Ledger «Qoʻngʻiroq natijasi»ni soʻraydi — belgilang yoki konsultatsiyaga yozing. Ilovani 3.2.4 ga yangilang: telefon «tebranish» rejimida ham titraydi.",
      },
      {
        to: (u) => u.role === "EMPLOYEE" && !isCallCenter(u.employee) && isCoordinator(u.employee),
        text: "Siz bilan gaplashgan odam firma raqamiga qoʻngʻiroq qilsa, avval sizga ulanadi (30 soniya), keyin call-markazga. Ilovani 3.2.4 ga yangilang: telefon «tebranish» rejimida ham titraydi.",
      },
    ],
  },
  {
    // Staff hear nothing yet: practice is shown to them at a meeting, and the
    // AI replies stay off until a manager switches them on.
    id: "2026-10-26-messages-ai-practice",
    date: "2026-10-26",
    boss: [
      "<b>Mijozlar xabarlari</b>: «Mijozlar Telegrami» endi shunday ataladi — Telegram bilan birga firma Instagrami ham shu yerda boʻladi (Instagram xabarlarga ruxsat berilgach). Roʻyxatda Telegram / Instagram boʻyicha filtr bor.",
      "<b>AI javoblar (beta)</b>: AI yangi odamlarga firmaning ssenariysi boʻyicha yozishi mumkin — muammosini bilib oladi, konsultatsiya nega kerakligini tushuntiradi, rozi boʻlsa operatorlarga xabar beradi. Yuridik javob bermaydi, toʻlov olmaydi. Hozircha oʻchiq: Sozlamalar → Mijozlar xabarlari → AI javoblar.",
      "<b>AI tahlilida belgilar</b>: yozishmalarda «Yuridik javob berilgan», «Notoʻgʻri narx» va «Koʻchirilgan matnga oʻxshaydi» — operatorning oʻz soʻzlari bilan. Natijalarda har bir xodim uchun soni koʻrinadi.",
      "<b>Mashq</b>: AI mijoz rolini oʻynaydi, xodim javob beradi, oxirida AI qoʻngʻiroq standarti boʻyicha baholaydi. Hozircha faqat rahbarlarga ochiq — sinab koʻring; xodimlarga ochish uchun Sozlamalar → Claude → «Mashq»ni yoqing.",
    ],
    staff: [],
  },
  {
    id: "2026-10-26-line-night-message",
    date: "2026-10-26",
    boss: [
      "<b>Firma raqamida ovozli xabarlar</b>: mijoz firmaning oʻz ovozida salomlashishni eshitadi. Hech kim boʻsh boʻlmasa, qoʻngʻiroq uzilmaydi — mijoz signaldan keyin ismi va masalasini aytib qoldiradi.",
      "<b>Ish vaqtidan tashqari</b> (Sozlamalar → Telefon liniyasi, masalan 22:00–08:00): kechasi hech kim chaqirilmaydi; mijoz xabar qoldiradi va u ertalab qayta qoʻngʻiroq roʻyxatida, eshitib boʻladigan yozuv bilan turadi.",
    ],
    staff: [
      {
        to: (u) => u.role === "EMPLOYEE" && isCallCenter(u.employee),
        text: "Firma raqamiga qoʻngʻiroq qilgan mijoz hech kim javob bermasa yoki ish vaqtidan tashqarida xabar qoldirishi mumkin. Javobsiz qoʻngʻiroqlarda «xabar qoldirdi» deb yozilgan boʻlsa, qoʻngʻiroqni ochib, avval mijozning xabarini eshiting — keyin qoʻngʻiroq qiling.",
      },
    ],
  },
  {
    id: "2026-10-24-bell-second-chance-tv",
    date: "2026-10-24",
    boss: [
      "<b>Bildirishnomalar 🔔</b>: asosiy sahifaning yuqori oʻng burchagida qoʻngʻiroqcha — Ledger yuborgan hamma narsa (Telegram, ilova, brauzer) bir joyda, yangilari soni bilan. Bosilsa, oʻsha sahifa ochiladi.",
      "<b>Yangi raqamlar: nima boʻldi?</b> endi uch guruhda: «Oʻylab koʻradi» — operator qachon yana gaplashishni belgilaydi va oʻsha kuni eslatma oladi; «Yoʻqotildi» (narx, boshqa firma, faqat savol…) — 3 kundan keyin navbatdagi boshqa operatorga «Ikkinchi imkoniyat» vazifasi beriladi; «Mijoz emas». Natijalarda har bir operator uchun: nechtasi keyin konsultatsiyaga yozildi.",
      "<b>TV ekran</b>: Sozlamalar → TV ekran — havolani ofisdagi televizor brauzerida bir marta oching: bugungi qoʻngʻiroqlar, javobsizlar, yozilganlar va har bir operator. Mijoz ismi va raqami koʻrinmaydi.",
      "<b>Ledger AI</b> koʻproq narsani biladi: raqam yoki mijoz boʻyicha qoʻngʻiroqlar, «oʻylab koʻradi» va ikkinchi imkoniyatlar, kim dam olishda, ogohlantirishlar, sud va boshqa sanalar, kimda qancha naqd pul (Moliya bilan). Telefon liniyasi yoqilgach — qoʻngʻiroq matni, AI tahlili va operator bahosi ham.",
      "<b>Ilova 3.2.0</b>: keyingi yangilanishlar ilovaning oʻzida yuklanadi — brauzer kerak emas.",
    ],
    staff: [
      {
        to: () => true,
        text: "Asosiy sahifaning yuqori oʻng burchagida qoʻngʻiroqcha 🔔 — Ledger sizga yuborgan barcha bildirishnomalar bir joyda.",
      },
      {
        to: (u) => u.role === "EMPLOYEE" && isCallCenter(u.employee),
        text: "«Yangi raqamlar: nima boʻldi?» endi uch guruhda. «Oʻylab koʻradi» ni tanlasangiz, qachon yana gaplashishni belgilaysiz — oʻsha kuni eslatma keladi. «Yoʻqotildi» deganlarni bir necha kundan keyin boshqa operator yana urinib koʻradi; sizga ham «Ikkinchi imkoniyat» vazifasi kelishi mumkin — qoʻngʻiroq qilib, natijasini javobga yozasiz.",
      },
      {
        to: (u) => u.role === "EMPLOYEE",
        text: "Ledger ilovasining yangi versiyasi (3.2.0) chiqdi — ilova taklif qilganda yangilang. Keyingi safar yangilanish ilovaning oʻzida yuklanadi.",
      },
    ],
  },
  {
    id: "2026-10-17-cancel-new-client",
    date: "2026-10-17",
    boss: [
      "<b>Nomlar avvalgidek</b>: «Konsultatsiya» va «Konsultatsiyalar». Konsultatsiya, kalendarga yozish va uchrashuv — bitta narsa: kalendardagi bekor qilinmagan yozuv.",
      "<b>Konsultatsiyani bekor qilish</b>: sababi tanlanadi (mijoz bekor qildi, boshqa kunga koʻchdi, advokat qabul qila olmadi, xato yozilgan), nima boʻlganini yozsa boʻladi va «Yangi konsultatsiyaga yozasizmi?» soʻraladi — «Ha» boʻlsa kalendar darhol ochiladi. Vaqti oʻtib, boʻlmay qolgan konsultatsiyani ham «Bekor boʻldi» deb belgilasa boʻladi — hisobga kirmaydi.",
      "<b>Yangi mijoz qoʻshishda</b> ikki savol: «Bu yangi mijozmi?» — faqat «Yangi mijoz» (firmaga birinchi marta murojaat qilgan) yangi mijoz boʻlib hisoblanadi; «Avvaldan mijozimiz» hisoblanmaydi. Keyin «Konsultatsiyaga ham yozasizmi?» — «Ha» boʻlsa saqlangach kalendar ochiladi. Xato tanlangan boʻlsa, mijoz sahifasida «Tahrirlash» orqali tuzatasiz.",
      "<b>Asosiy sahifa</b>: qoʻngʻiroqlar «Kiruvchi» (javobsizlari bilan) va «Chiquvchi» (nechtasi ulangani) boʻyicha ham koʻrinadi.",
    ],
    staff: [
      {
        to: (u) => u.role === "EMPLOYEE" || isLawyerUser(u),
        text: "Yangi mijoz qoʻshayotganda Ledger soʻraydi: «Bu yangi mijozmi?» — firmaga birinchi marta murojaat qilgan boʻlsa «Yangi mijoz», avval firma bilan ishlagan boʻlsa «Avvaldan mijozimiz» (bunisi yangi mijoz boʻlib hisoblanmaydi).",
      },
      {
        to: (u) => u.role === "EMPLOYEE" && (books(u) || isCallCenter(u.employee)),
        text: "Mijoz qoʻshganda «Konsultatsiyaga ham yozasizmi?» soʻraladi — «Ha» boʻlsa kalendar ochiladi. Konsultatsiyani bekor qilganda sababini tanlang va yangi vaqtga yozasizmi — ayting. Asosiy sahifada kiruvchi va chiquvchi qoʻngʻiroqlar alohida koʻrinadi.",
      },
    ],
  },
  {
    // The release date goes here when it's pushed (notes go out within
    // SEND_DAYS of it).
    id: "2026-10-17-consultations-answers",
    date: "2026-10-17",
    boss: [
      "<b>Konsultatsiya = kalendarga yozilgan uchrashuv.</b> Endi bitta raqam: operator yozgan konsultatsiyalar (bekor qilinganidan tashqari) oʻz kunida hisoblanadi — «Keldi» belgilanmagan boʻlsa ham. Alohida «Kalendarga yozgan» olib tashlandi; oylik reja shu raqamga.",
      "<b>Yozilmasdan kelgan mijoz</b>: Kalendarda bugungi kun ostida «Yozilmasdan kelgan mijozni yozish» — konsultatsiya «Keldi» deb saqlanadi va hisoblanadi.",
      "<b>Vazifaga javob</b>: vazifa berayotganda «Javob yozsin» ni yoqing — xodim javobini yozmaguncha vazifani bajarildi deb belgilay olmaydi. Javob sizga Telegramda va Vazifalarda keladi.",
      "<b>Yangi raqamlar: nima boʻldi?</b> Operator gaplashgan, lekin konsultatsiyaga yozilmagan har bir yangi raqamga bitta sabab belgilaydi: narx, faqat savol, boshqa joyga ketdi… Sabablar Asosiy sahifadagi voronkada; «Har bir operator» — operatorlar yonma-yon.",
      "<b>Ledger AI</b>: u tayyorlagan vazifa va eslatmalarda muallif «Ledger AI» deb yoziladi; ochiq vazifani oʻzgartira oladi (har doim tasdiqlash bilan) va xodimlarning javoblarini oʻqiydi. Oʻchira olmaydi, pulga tegmaydi. Baʼzan chiqqan «Claude javob bermadi» xatosi tuzatildi.",
    ],
    staff: [
      {
        to: (u) => u.role === "EMPLOYEE" && isCallCenter(u.employee),
        text: "Konsultatsiyalaringiz endi kalendarga yozganlaringiz boʻyicha hisoblanadi (bekor qilinganidan tashqari) — «Keldi» belgilanmagan boʻlsa ham. Yozilmasdan kelgan mijozni Kalendarda bugungi kun ostidagi tugma bilan yozing. Asosiy sahifada «Yangi raqamlar: nima boʻldi?» — gaplashib, yozilmagan har bir yangi raqamga bitta sabab belgilang.",
      },
      {
        to: (u) => u.role === "EMPLOYEE" || isLawyerUser(u),
        text: "Vazifaga javob yozsa boʻladi: vazifani oching, javobingizni yozing va «Bajarildi» ni bosing. «Javob yozsin» deb berilgan vazifani javobsiz bajarib boʻlmaydi.",
      },
      {
        to: (u) => isLawyerUser(u),
        text: "Yozilmasdan kelgan mijozni kalendaringizda bugungi kun ostidagi «Yozilmasdan kelgan mijozni yozish» bilan yozing — konsultatsiya hisoblanadi va yakunini yozish eslatiladi.",
      },
    ],
  },
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

// The whole release, for the firm's Telegram groups (telegram/groups.js):
// everything the boss gets — it's about Ledger, not about any client.
function groupMessage(news) {
  if (!news.boss?.length) return null;
  return ["🆕 <b>Ledger yangilandi</b>", ...news.boss.map((l) => `• ${l}`)].join("\n");
}

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
  const { postToGroups } = require("./telegram/groups");
  for (const news of current) {
    const forGroups = groupMessage(news);
    if (forGroups) sent += await postToGroups(`news:${news.id}`, forGroups);
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

module.exports = { NEWS, messageFor, groupMessage, newsTick, parseDeployLog, deployMessage, deployTick };
