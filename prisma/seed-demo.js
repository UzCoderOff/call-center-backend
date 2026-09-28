// Fills a DEVELOPMENT database with realistic-looking demo data: offices,
// positions and daily report forms; call-center staff with ~30 days of calls
// (including missed calls, callbacks and unanswered callback attempts);
// office staff (translation, document services) with ~10 days of reports;
// the lawyer's calendar; made-up clients with cases and payments; and a boss
// account — so every screen of the portal has something to show.
//
//   DEMO_PASSWORD=<something> npm run seed:demo
//
// Every demo account gets DEMO_PASSWORD as its password. Optionally,
// DEMO_RECORDING=<path to an audio file> attaches a copy of that file to
// some answered calls so the player can be tried out.
//
// Refuses to run with NODE_ENV=production — this is never for real data.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const prisma = require("../src/lib/prisma");
const env = require("../src/config/env");
const { phoneKey } = require("../src/lib/phone");
const { reconcileFollowUps } = require("../src/services/followUp");
const { normalizeFields } = require("../src/services/reportFields");
const { usualWeekOf, usualWeekBlocks } = require("../src/services/calendar");
const { firmDate, shiftDate, weekStartOf } = require("../src/lib/firmTime");
const cl = require("../src/services/clients");
const { refreshSearch } = require("../src/lib/clientsDb");
const { lawyerAccounts, matchLawyer } = require("../src/lib/lawyers");

if (env.nodeEnv === "production") {
  console.error("seed-demo refuses to run with NODE_ENV=production.");
  process.exit(1);
}

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
if (!DEMO_PASSWORD || DEMO_PASSWORD.length < 8) {
  console.error("Set DEMO_PASSWORD (8+ characters) — every demo account gets it as its password.");
  process.exit(1);
}

const OFFICES = [
  { key: "main", name: "Bosh ofis", address: "Toshkent, Yunusobod" },
  { key: "court", name: "Sud yonidagi filial", address: "Toshkent, Mirzo Ulugʻbek" },
  { key: "translation", name: "Tarjima markazi", address: "Toshkent, Chilonzor" },
];

const TEMPLATES = [
  {
    key: "callcenter",
    name: "Call-markaz: kunlik hisobot",
    fields: [
      { id: "appointments", label: "Bugun nechta uchrashuv belgilandi?", type: "number", required: true },
      { id: "allCalledBack", label: "Barcha javobsiz qoʻngʻiroqlarga qayta qoʻngʻiroq qildingizmi?", type: "yesno", required: true },
      { id: "notes", label: "Qiyin holatlar yoki savollar", type: "textarea" },
    ],
  },
  {
    key: "translation",
    name: "Tarjima: kunlik hisobot",
    fields: [
      { id: "docs", label: "Tarjima qilingan hujjatlar soni", type: "number", required: true },
      { id: "langs", label: "Qaysi tillardan/tillarga", type: "checklist", options: ["Rus", "Ingliz", "Turk", "Nemis", "Arab"] },
      { id: "cash", label: "Tushum (soʻm)", type: "money", required: true },
      { id: "notes", label: "Izoh", type: "textarea" },
    ],
  },
  {
    key: "documents",
    name: "Hujjat xizmatlari: kunlik hisobot",
    fields: [
      { id: "clients", label: "Xizmat koʻrsatilgan mijozlar soni", type: "number", required: true },
      { id: "work", label: "Bajarilgan ishlar", type: "checklist", options: ["Nusxa koʻchirish", "Skanerlash", "Hujjat yuborish", "Ariza toʻldirish", "Boshqa"] },
      { id: "cash", label: "Tushum (soʻm)", type: "money", required: true },
      { id: "problems", label: "Muammolar boʻldimi?", type: "yesno", required: true },
      { id: "notes", label: "Izoh", type: "textarea" },
    ],
  },
];

const POSITIONS = [
  { key: "operator", name: "Call-markaz operatori", collectCalls: true, autoReport: true, calendarAccess: "book", template: "callcenter", targetConsultations: 40, targetContracts: 12 },
  { key: "translator", name: "Tarjimon", collectCalls: false, calendarAccess: "view", template: "translation" },
  { key: "clerk", name: "Hujjat xizmatlari xodimi", collectCalls: false, calendarAccess: "none", template: "documents" },
];

const H = (h, m = 0) => h * 60 + m;
const MATTERS = ["Ajrashish boʻyicha maslahat", "Meros masalasi", "Mehnat nizosi", "Shartnoma tekshiruvi", "Uy-joy masalasi"];
const CLIENT_NAMES = ["Rustam Qodirov", "Gulnora Saidova", "Jasur Tursunov", "Shahlo Nazarova", "Bobur Ismoilov", "Zarina Olimova", "Sherzod Aminov"];

const EMPLOYEES = [
  { name: "Dilnoza Karimova", username: "dilnoza", phoneNumber: "+998 90 111 22 33", office: "main", position: "operator" },
  { name: "Aziz Rahimov", username: "aziz", phoneNumber: "+998 91 222 33 44", office: "main", position: "operator" },
  { name: "Malika Yusupova", username: "malika", phoneNumber: "+998 93 333 44 55", office: "main", position: "operator" },
  { name: "Nodira Tosheva", username: "nodira", phoneNumber: "+998 94 444 55 66", office: "translation", position: "translator" },
  { name: "Sardor Aliyev", username: "sardor", phoneNumber: null, office: "court", position: "clerk" },
  { name: "Kamola Ergasheva", username: "kamola", phoneNumber: "+998 97 666 77 88", office: "court", position: "clerk" },
];
const REPORT_DAYS = 10;
const BOSS_USERNAME = "rahbar";
// A second lawyer: a LAWYER account — sees only her own calendar and cases.
const LAWYER = { username: "rashidova", name: "Rashidova Madina", calendar: "Advokat Rashidova" };
const DAYS = 30;
const MIN = 60 * 1000;

// Deterministic randomness so every run produces the same demo.
let seed = 42;
function rand() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (a, b) => a + Math.floor(rand() * (b - a + 1));

const OPERATORS = ["90", "91", "93", "94", "95", "97", "98", "99", "33", "88"];
const CLIENTS = Array.from({ length: 400 }, () => {
  const op = pick(OPERATORS);
  const rest = String(between(1000000, 9999999));
  return `+998${op}${rest}`;
});

async function upsertUser(username, role, passwordHash) {
  return prisma.user.upsert({
    where: { username },
    update: { passwordHash, role, active: true, mustChangePassword: false, passwordChangedAt: new Date() },
    create: { username, passwordHash, role, mustChangePassword: false, passwordChangedAt: new Date() },
  });
}

function demoAnswers(fields) {
  const answers = {};
  for (const f of fields) {
    if (f.type === "number") answers[f.id] = between(2, 18);
    else if (f.type === "money") answers[f.id] = between(4, 40) * 25000;
    else if (f.type === "yesno") answers[f.id] = rand() < 0.8;
    else if (f.type === "checklist") answers[f.id] = f.options.filter(() => rand() < 0.45);
    else if (f.type === "select") answers[f.id] = pick(f.options);
    else if (f.type === "textarea" && rand() < 0.4) {
      answers[f.id] = pick(["Hammasi reja boʻyicha.", "Printer ikki marta ishlamay qoldi.", "Mijozlar koʻp boʻldi."]);
    }
  }
  return answers;
}

async function main() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  await upsertUser(BOSS_USERNAME, "BOSS", passwordHash);
  const lawyerUser = await upsertUser(LAWYER.username, "LAWYER", passwordHash);
  await prisma.user.update({ where: { id: lawyerUser.id }, data: { name: LAWYER.name } });

  const offices = {};
  for (const o of OFFICES) {
    offices[o.key] = await prisma.office.upsert({
      where: { name: o.name },
      update: { address: o.address, active: true },
      create: { name: o.name, address: o.address },
    });
  }
  const templates = {};
  for (const tpl of TEMPLATES) {
    const fields = normalizeFields(tpl.fields);
    const existing = await prisma.reportTemplate.findFirst({ where: { name: tpl.name } });
    templates[tpl.key] = existing
      ? await prisma.reportTemplate.update({ where: { id: existing.id }, data: { fields, active: true } })
      : await prisma.reportTemplate.create({ data: { name: tpl.name, fields } });
  }
  const positions = {};
  for (const p of POSITIONS) {
    const data = {
      collectCalls: p.collectCalls,
      autoReport: Boolean(p.autoReport),
      calendarAccess: p.calendarAccess,
      reportTemplateId: templates[p.template].id,
      targetConsultations: p.targetConsultations ?? null,
      targetContracts: p.targetContracts ?? null,
    };
    positions[p.key] = await prisma.position.upsert({ where: { name: p.name }, update: data, create: { name: p.name, ...data } });
  }

  const employees = [];
  for (const e of EMPLOYEES) {
    const user = await upsertUser(e.username, "EMPLOYEE", passwordHash);
    const position = positions[e.position];
    const data = {
      name: e.name,
      phoneNumber: e.phoneNumber,
      officeId: offices[e.office].id,
      positionId: position.id,
      collectCalls: position.collectCalls,
      autoReport: position.autoReport,
      calendarAccess: position.calendarAccess,
      reportTemplateId: position.reportTemplateId,
    };
    const existing = await prisma.employee.findUnique({ where: { userId: user.id } });
    employees.push(
      existing
        ? await prisma.employee.update({ where: { id: existing.id }, data })
        : await prisma.employee.create({ data: { ...data, employeeId: crypto.randomBytes(20).toString("hex"), userId: user.id } })
    );
  }

  const recordingSource = process.env.DEMO_RECORDING;
  const now = Date.now();
  let created = 0;

  for (const employee of employees.filter((e) => e.collectCalls)) {
    await prisma.callLog.deleteMany({ where: { employeeId: employee.id } });
    let callLogId = 1;
    const rows = [];
    const add = (fields) => rows.push({ ...fields, deviceCallLogId: String(callLogId++) });

    for (let day = DAYS; day >= 0; day--) {
      const dayStart = new Date(now - day * 24 * 60 * MIN);
      dayStart.setHours(9, 0, 0, 0);
      const weekend = [0, 6].includes(dayStart.getDay());
      const count = weekend ? between(0, 3) : between(6, 16);

      for (let i = 0; i < count; i++) {
        const at = dayStart.getTime() + between(0, 9 * 60) * MIN;
        if (at > now) continue;
        const number = pick(CLIENTS);
        const r = rand();

        if (r < 0.2) {
          const rejected = rand() < 0.3;
          add({ at, number, callType: rejected ? "rejected" : "missed", missed: true, duration: 0 });
          // Most missed calls get called back; some only get an unanswered attempt.
          const f = rand();
          const back = at + between(3, 120) * MIN;
          if (back < now && f < 0.7) add({ at: back, number, callType: "outgoing", missed: false, duration: between(40, 420) });
          else if (back < now && f < 0.82) add({ at: back, number, callType: "outgoing", missed: false, duration: 0 });
        } else if (r < 0.62) {
          add({ at, number, callType: "incoming", missed: false, duration: between(20, 900) });
        } else {
          add({ at, number, callType: "outgoing", missed: false, duration: rand() < 0.15 ? 0 : between(20, 600) });
        }
      }
    }

    for (const row of rows) {
      let recordingPath = null;
      let recordingFilename = null;
      if (recordingSource && row.duration > 0 && rand() < 0.35) {
        const ext = path.extname(recordingSource).toLowerCase();
        recordingFilename = `demo_${row.deviceCallLogId}${ext}`;
        recordingPath = path.join(String(employee.id), `${row.at}-${row.deviceCallLogId}${ext}`);
        fs.mkdirSync(path.join(env.storageRoot, String(employee.id)), { recursive: true });
        fs.copyFileSync(recordingSource, path.join(env.storageRoot, recordingPath));
      }
      const key = phoneKey(row.number);
      await prisma.callLog.create({
        data: {
          employeeId: employee.id,
          deviceCallLogId: row.deviceCallLogId,
          phoneNumber: row.number,
          phoneKey: key,
          callType: row.callType,
          missed: row.missed,
          callTimestampMs: BigInt(row.at),
          durationSeconds: row.duration,
          syncedAtMs: BigInt(Math.min(now, row.at + 30 * MIN)),
          recordingFilename,
          recordingPath,
          followUp: row.missed ? (key ? "pending" : "no_number") : null,
        },
      });
      created += 1;
    }

    // One recent, successful sync per phone so the "sync status" UI has data.
    await prisma.syncLog.create({
      data: { employeeId: employee.employeeId, ok: true, httpStatus: 200, callCount: 12, recordingCount: 3, appVersion: "demo" },
    });
  }

  const keys = [...new Set(CLIENTS.map(phoneKey))];
  const changed = await reconcileFollowUps(keys);

  // Daily reports for the last REPORT_DAYS days (not Sundays). Most people
  // submit most days; today is left partly empty so "who hasn't submitted
  // yet" has something to show. Older reports are mostly reviewed.
  const boss = await prisma.user.findUnique({ where: { username: BOSS_USERNAME } });
  const today = firmDate();
  let reportCount = 0;
  for (const employee of employees) {
    await prisma.report.deleteMany({ where: { employeeId: employee.id } });
    const template = Object.values(templates).find((t) => t.id === employee.reportTemplateId);
    // Call-center staff don't fill in forms: their report is automatic.
    if (!template || employee.autoReport) continue;
    for (let back = REPORT_DAYS; back >= 0; back--) {
      const date = shiftDate(today, -back);
      if (new Date(date + "T12:00:00Z").getUTCDay() === 0) continue;
      if (rand() > (back === 0 ? 0.5 : 0.88)) continue;
      const reviewed = back > 1 && rand() < 0.8;
      await prisma.report.create({
        data: {
          employeeId: employee.id,
          templateId: template.id,
          date,
          fields: template.fields,
          answers: demoAnswers(template.fields),
          reviewedById: reviewed ? boss.id : null,
          reviewedAt: reviewed ? new Date() : null,
          reviewComment: reviewed && rand() < 0.3 ? "Yaxshi ish, rahmat!" : null,
        },
      });
      reportCount += 1;
    }
  }

  // The lawyer's calendar with the default usual week (Mon-Fri 9-18, lunch
  // 12-13): this week and next published, the week after not planned yet.
  // Appointments booked by the call-center staff (some from real calls);
  // next Wednesday became a court day in another city, which cancelled that
  // day's bookings — the operators who booked them are asked to call.
  const calendar = await prisma.calendar.upsert({
    where: { ownerId: boss.id },
    // Back to the defaults, in case they were changed while testing.
    update: { name: "Advokat Karimov", active: true, workDays: "1,2,3,4,5", dayStart: H(9), dayEnd: H(18), lunchStart: H(12), lunchEnd: H(13), slotMinutes: 30 },
    create: { ownerId: boss.id, name: "Advokat Karimov" },
  });
  await prisma.appointment.deleteMany({ where: { calendarId: calendar.id } });
  await prisma.calendarWeek.deleteMany({ where: { calendarId: calendar.id } });
  const usual = usualWeekOf(calendar);
  const thisWeek = weekStartOf(today);
  const operators = employees.filter((e) => e.collectCalls);
  const operatorUsers = await prisma.user.findMany({ where: { id: { in: operators.map((e) => e.userId) } } });
  let appointmentCount = 0;
  // Each section starts its own random sequence, so changing one section
  // never reshuffles the next.
  seed = 7;
  for (const weekStart of [thisWeek, shiftDate(thisWeek, 7)]) {
    const blocks = usualWeekBlocks(usual, weekStart);
    await prisma.calendarWeek.create({
      data: { calendarId: calendar.id, weekStart, status: "published", publishedAt: new Date(), blocks },
    });
    for (const block of blocks.filter((b) => b.kind === "available")) {
      for (let start = block.start; start + 30 <= block.end; start += 60) {
        if (rand() > 0.35) continue;
        const booker = pick(operatorUsers);
        const past = block.date < today;
        const recentCall = await prisma.callLog.findFirst({
          where: { employee: { userId: booker.id }, missed: false },
          orderBy: { callTimestampMs: "desc" },
          skip: between(0, 20),
        });
        await prisma.appointment.create({
          data: {
            calendarId: calendar.id,
            date: block.date,
            start,
            end: start + 30,
            clientName: pick(CLIENT_NAMES),
            clientPhone: recentCall?.phoneNumber ?? null,
            phoneKey: recentCall?.phoneKey ?? null,
            matter: pick(MATTERS),
            status: past ? (rand() < 0.8 ? "attended" : "no_show") : "booked",
            bookedById: booker.id,
            callLogId: recentCall?.id ?? null,
          },
        });
        appointmentCount += 1;
      }
    }
  }

  const courtDay = shiftDate(thisWeek, 9);
  // Every operator has someone booked that day, so each of them gets a
  // "tell the client" card when it becomes a court day.
  const courtStarts = usualWeekBlocks(usual, shiftDate(thisWeek, 7))
    .filter((b) => b.date === courtDay && b.kind === "available")
    .flatMap((b) => Array.from({ length: Math.floor((b.end - b.start) / 30) }, (_, i) => b.start + i * 30));
  const takenStarts = new Set(
    (await prisma.appointment.findMany({ where: { calendarId: calendar.id, date: courtDay }, select: { start: true } })).map((a) => a.start)
  );
  const freeStarts = courtStarts.filter((m) => !takenStarts.has(m) && !takenStarts.has(m - 30) && !takenStarts.has(m + 30));
  for (const booker of operatorUsers) {
    const has = await prisma.appointment.count({ where: { calendarId: calendar.id, date: courtDay, bookedById: booker.id } });
    if (has > 0 || freeStarts.length === 0) continue;
    const start = freeStarts.shift();
    freeStarts.splice(0, freeStarts.length, ...freeStarts.filter((m) => Math.abs(m - start) >= 60));
    await prisma.appointment.create({
      data: { calendarId: calendar.id, date: courtDay, start, end: start + 30, clientName: pick(CLIENT_NAMES), matter: pick(MATTERS), status: "booked", bookedById: booker.id },
    });
    appointmentCount += 1;
  }
  const nextWeek = await prisma.calendarWeek.findUnique({
    where: { calendarId_weekStart: { calendarId: calendar.id, weekStart: shiftDate(thisWeek, 7) } },
  });
  await prisma.calendarWeek.update({
    where: { id: nextWeek.id },
    data: {
      blocks: [
        ...nextWeek.blocks.filter((b) => b.date !== courtDay),
        { date: courtDay, start: 0, end: 24 * 60, kind: "busy", note: "Samarqand sudi" },
      ].sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start),
    },
  });
  await prisma.appointment.updateMany({
    where: { calendarId: calendar.id, date: courtDay, status: "booked" },
    data: { status: "cancelled", cancelReason: "Samarqand sudi", cancelledById: boss.id, cancelledAt: new Date() },
  });

  seed = 11;
  const lawyerCalendar = await prisma.calendar.upsert({
    where: { ownerId: lawyerUser.id },
    update: { name: LAWYER.calendar, active: true, workDays: "1,2,3,4,5", dayStart: H(10), dayEnd: H(17), lunchStart: H(13), lunchEnd: H(14), slotMinutes: 30 },
    create: { ownerId: lawyerUser.id, name: LAWYER.calendar, dayStart: H(10), dayEnd: H(17), lunchStart: H(13), lunchEnd: H(14) },
  });
  await prisma.appointment.deleteMany({ where: { calendarId: lawyerCalendar.id } });
  await prisma.calendarWeek.deleteMany({ where: { calendarId: lawyerCalendar.id } });
  for (const weekStart of [thisWeek, shiftDate(thisWeek, 7)]) {
    const blocks = usualWeekBlocks(usualWeekOf(lawyerCalendar), weekStart);
    await prisma.calendarWeek.create({ data: { calendarId: lawyerCalendar.id, weekStart, status: "published", publishedAt: new Date(), blocks } });
    for (const block of blocks.filter((b) => b.kind === "available")) {
      for (let start = block.start; start + 30 <= block.end; start += 90) {
        if (rand() > 0.3) continue;
        const booker = pick(operatorUsers);
        const recentCall = await prisma.callLog.findFirst({
          where: { employee: { userId: booker.id }, missed: false },
          orderBy: { callTimestampMs: "desc" },
          skip: between(20, 40),
        });
        await prisma.appointment.create({
          data: {
            calendarId: lawyerCalendar.id,
            date: block.date,
            start,
            end: start + 30,
            clientName: pick(CLIENT_NAMES),
            clientPhone: recentCall?.phoneNumber ?? null,
            phoneKey: recentCall?.phoneKey ?? null,
            matter: pick(MATTERS),
            status: block.date < today ? (rand() < 0.8 ? "attended" : "no_show") : "booked",
            bookedById: booker.id,
            callLogId: recentCall?.id ?? null,
          },
        });
        appointmentCount += 1;
      }
    }
  }

  const clientCount = await seedClients({ boss, operators, today });

  console.log(
    `Demo data ready: ${employees.length} employees, ${created} calls, ${changed} missed calls resolved, ${reportCount} reports, ${appointmentCount} appointments, ${clientCount} clients.`
  );
  console.log(`Logins: ${BOSS_USERNAME} (BOSS), ${LAWYER.username} (LAWYER), ${EMPLOYEES.map((e) => e.username).join(", ")} (EMPLOYEE) — password from DEMO_PASSWORD.`);
}

// ---------------------------------------------------------------- clients
// Made-up clients (invented names, numbers from the demo calls above) at
// every step: consultations, "call again", contracts at different court
// stages with full, partial and no payment, finished and declined cases, a
// few connections, one archived client and one entered twice (to try
// "merge a duplicate" on). Clients whose number was booked in the calendar
// are linked to those appointments.
const FIRST = [
  ["Jasur", false], ["Dilshod", false], ["Bekzod", false], ["Otabek", false], ["Sardor", false], ["Umid", false],
  ["Kamron", false], ["Ulugʻbek", false], ["Aziza", true], ["Madina", true], ["Nigora", true], ["Feruza", true],
  ["Laylo", true], ["Sevara", true], ["Nilufar", true],
];
const LAST = ["Qodirov", "Saidov", "Tursunov", "Nazarov", "Ismoilov", "Olimov", "Aminov", "Rahmonov", "Mirzayev", "Xoliqov", "Yoʻldoshev"];
// Some staff type names in Cyrillic; search finds them either way.
const CYRILLIC_NAMES = ["Каримов Жасур", "Салимова Мадина", "Холматов Шерзод", "Юсупова Нигора", "Эргашев Бахтиёр"];
const CITIES = ["Toshkent", "Toshkent", "Toshkent", "Samarqand", "Buxoro", "Andijon", "Fargʻona", "Namangan", "Qarshi"];
const CASE_MATTERS = [
  "Ajrashish va aliment",
  "Meros taqsimoti",
  "Mehnat nizosi: ishdan boʻshatish",
  "Kredit qarzi boʻyicha daʼvo",
  "Uy-joy oldi-sotdisi",
  "Jinoiy ish: himoya",
  "Yer uchastkasi nizosi",
  "Shartnoma tekshiruvi",
];
const LAWYERS = ["Karimov A.", "Rashidova M."];
const NOTES = [
  "Hujjatlar nusxasini olib keladi.",
  "Kechqurun qoʻngʻiroq qilishni soʻradi.",
  "Oldin boshqa advokatga murojaat qilgan.",
  "Telegramda yozishni afzal koʻradi.",
];
const CALL_NOTES = ["Qarorini aytadi", "Hujjatlarni olib keladi", "Toʻlov boʻyicha eslatish"];
const DEMO_CLIENTS = 46;
const DAY = 24 * 60 * MIN;

function demoName(i) {
  if (i % 9 === 4) return CYRILLIC_NAMES[Math.floor(i / 9) % CYRILLIC_NAMES.length];
  const [first, female] = pick(FIRST);
  const last = pick(LAST);
  return `${female ? `${last}a` : last} ${first}`;
}

function demoStatus() {
  const r = rand();
  if (r < 0.28) return "consultation";
  if (r < 0.42) return "call_again";
  if (r < 0.75) return "contract";
  if (r < 0.87) return "done";
  return "declined";
}

const minDate = (a, b) => (a < b ? a : b);

async function demoCase(clientId, { status, start, today, operatorId, bossId, lawyers }) {
  const consulted = ["consultation", "contract", "done", "declined"].includes(status);
  const signed = status === "contract" || status === "done";
  const contractDate = signed ? minDate(shiftDate(start, between(0, 6)), today) : null;
  const legalStage = status === "done" ? pick(cl.LEGAL_STAGES.slice(3, 6)) : status === "contract" ? pick(cl.LEGAL_STAGES.slice(0, 6)) : null;
  const inCourt = legalStage && cl.LEGAL_STAGES.indexOf(legalStage) >= cl.LEGAL_STAGES.indexOf("sent_to_court");
  const contractAmount = signed ? between(6, 60) * 500000 : null;
  const c = await prisma.clientCase.create({
    data: {
      clientId,
      matter: pick(CASE_MATTERS),
      number: inCourt ? `2-${between(1000, 9999)}/2026` : null,
      ...lawyerFields(signed ? pick(LAWYERS) : null, lawyers),
      operatorId,
      status,
      legalStage,
      startDate: start,
      consultationDate: consulted ? start : null,
      contractDate,
      contractAmount,
      createdAt: new Date(`${start}T10:00:00Z`),
    },
  });
  await prisma.clientEvent.create({
    data: { clientId, caseId: c.id, kind: "case", text: c.matter, authorId: bossId, createdAt: new Date(`${start}T10:00:00Z`) },
  });

  // Consultation fee for some; contracts paid in full, in part or not yet.
  if (status === "consultation" && rand() < 0.5) {
    await prisma.payment.create({
      data: { clientId, caseId: c.id, amount: 200000, date: start, method: "cash", kind: "consultation", recordedById: bossId },
    });
  }
  let debt = 0;
  if (signed) {
    const share = status === "done" ? 1 : pick([0, 0.3, 0.5, 1]);
    const total = Math.round((contractAmount * share) / 100000) * 100000;
    const parts = total === 0 ? 0 : between(1, 3);
    let left = total;
    for (let p = 0; p < parts; p++) {
      const amount = p === parts - 1 ? left : Math.round(total / parts / 100000) * 100000;
      left -= amount;
      await prisma.payment.create({
        data: {
          clientId,
          caseId: c.id,
          amount,
          date: minDate(shiftDate(contractDate, p * between(5, 15)), today),
          method: pick(cl.PAYMENT_METHODS),
          kind: "contract",
          recordedById: bossId,
        },
      });
    }
    debt = contractAmount - total;
  }
  return { debt };
}

// A lawyer written on a case -> their account, as the import does it.
function lawyerFields(name, lawyers) {
  if (!name) return { lawyer: null };
  const account = matchLawyer(name, lawyers);
  return account ? { lawyer: account.name, lawyerId: account.id } : { lawyer: name };
}

async function seedClients({ boss, operators, today }) {
  const lawyers = await lawyerAccounts();
  const now = Date.now();
  seed = 2026;
  // Numbers booked in the calendar first (so those appointments get their
  // client), then other numbers from the demo calls.
  const booked = await prisma.appointment.findMany({ where: { phoneKey: { not: null } }, select: { clientPhone: true }, orderBy: { id: "asc" } });
  const numbers = [...new Set([...booked.map((a) => a.clientPhone), ...CLIENTS])].slice(0, DEMO_CLIENTS + 1);
  const keys = numbers.map(phoneKey);

  // A previous run's demo clients (everything about them goes with them).
  await prisma.client.deleteMany({ where: { phones: { some: { phoneKey: { in: keys } } } } });

  const ids = [];
  for (let i = 0; i < DEMO_CLIENTS; i++) {
    const phones = [{ phone: numbers[i], phoneKey: keys[i] }];
    if (rand() < 0.15) {
      const second = `+998${pick(OPERATORS)}${between(1000000, 9999999)}`;
      phones.push({ phone: second, phoneKey: phoneKey(second) });
    }
    const start = shiftDate(today, -between(0, 70));
    const status = demoStatus();
    const client = await prisma.client.create({
      data: {
        name: demoName(i),
        city: rand() < 0.8 ? pick(CITIES) : null,
        source: pick(["call", "call", "call", "call", "telegram", "instagram", "referral", "walk_in"]),
        createdById: boss.id,
        createdAt: new Date(`${start}T09:30:00Z`),
        phones: { create: phones },
      },
    });
    const operatorId = pick(operators).id;
    const { debt } = await demoCase(client.id, { status, start, today, operatorId, bossId: boss.id, lawyers });
    // An older, finished case for some.
    if (rand() < 0.12) await demoCase(client.id, { status: "done", start: shiftDate(start, -between(120, 300)), today, operatorId, bossId: boss.id, lawyers });

    // Who to call and when: "call again" clients (some overdue, some today,
    // some later) and some who owe money.
    let nextCallAt = null;
    if (status === "call_again" || (debt > 0 && rand() < 0.5)) {
      const r = rand();
      nextCallAt = new Date(r < 0.3 ? now - between(1, 3) * DAY : r < 0.65 ? now + between(1, 4) * 60 * MIN : now + between(1, 7) * DAY);
    }
    await prisma.client.update({
      where: { id: client.id },
      data: { nextCallAt, nextCallNote: nextCallAt ? (debt > 0 ? CALL_NOTES[2] : pick(CALL_NOTES.slice(0, 2))) : null },
    });
    if (rand() < 0.3) {
      await prisma.clientEvent.create({ data: { clientId: client.id, kind: "note", text: pick(NOTES), authorId: pick([boss.id, ...operators.map((e) => e.userId)]) } });
    }
    await refreshSearch(prisma, client.id);
    ids.push(client.id);
  }

  // Connections between some of them.
  const LINKS = [
    [0, 1, "family", "Turmush oʻrtogʻi"],
    [2, 3, "referral", null],
    [5, 6, "same_case", null],
    [8, 9, "family", "Aka-uka"],
  ];
  for (const [a, b, kind, label] of LINKS) {
    await prisma.clientLink.create({ data: { fromId: ids[a], toId: ids[b], kind, label } });
  }

  // One archived client (a declined inquiry from a while ago).
  await prisma.client.update({ where: { id: ids[ids.length - 1] }, data: { archivedAt: new Date(now - 10 * DAY) } });
  await prisma.clientEvent.create({ data: { clientId: ids[ids.length - 1], kind: "archive", text: "", authorId: boss.id } });

  // The same person entered twice: the second time in Cyrillic, from their
  // other number — to try "merge a duplicate" on.
  const original = await prisma.client.findUnique({ where: { id: ids[1] } });
  const [last, first] = original.name.split(" ");
  const twin = await prisma.client.create({
    data: {
      name: `${cyrillic(last)} ${cyrillic(first)}`,
      source: "telegram",
      createdById: boss.id,
      phones: { create: [{ phone: numbers[DEMO_CLIENTS], phoneKey: keys[DEMO_CLIENTS] }] },
    },
  });
  await demoCase(twin.id, { status: "consultation", start: shiftDate(today, -2), today, operatorId: pick(operators).id, bossId: boss.id, lawyers });
  await refreshSearch(prisma, twin.id);

  // Calendar bookings belong to their clients.
  const byKey = new Map(
    (await prisma.clientPhone.findMany({ where: { phoneKey: { in: keys } }, select: { phoneKey: true, client: { select: { id: true, name: true } } } })).map(
      (p) => [p.phoneKey, p.client]
    )
  );
  // …and a client booked with a lawyer is that lawyer's (their open case).
  for (const a of await prisma.appointment.findMany({ where: { phoneKey: { in: keys } }, include: { calendar: { select: { ownerId: true } } } })) {
    const client = byKey.get(a.phoneKey);
    await prisma.appointment.update({ where: { id: a.id }, data: { clientId: client.id, clientName: client.name } });
    const lawyer = lawyers.find((l) => l.id === a.calendar.ownerId);
    if (lawyer) {
      await prisma.clientCase.updateMany({
        where: { clientId: client.id, lawyerId: null, status: { in: cl.OPEN_STATUSES } },
        data: { lawyerId: lawyer.id, lawyer: lawyer.name },
      });
    }
  }
  return ids.length + 1;
}

// Latin -> Cyrillic, just enough for the demo names above.
function cyrillic(word) {
  const MAP = [
    ["sh", "ш"], ["ch", "ч"], ["yo", "ё"], ["yu", "ю"], ["ya", "я"], ["oʻ", "ў"], ["gʻ", "ғ"],
    ["a", "а"], ["b", "б"], ["d", "д"], ["e", "е"], ["f", "ф"], ["g", "г"], ["h", "ҳ"], ["i", "и"], ["j", "ж"], ["k", "к"],
    ["l", "л"], ["m", "м"], ["n", "н"], ["o", "о"], ["p", "п"], ["q", "қ"], ["r", "р"], ["s", "с"], ["t", "т"], ["u", "у"],
    ["v", "в"], ["x", "х"], ["y", "й"], ["z", "з"],
  ];
  let out = "";
  let rest = word;
  while (rest) {
    const lower = rest.toLowerCase();
    const hit = MAP.find(([lat]) => lower.startsWith(lat));
    if (!hit) {
      out += rest[0];
      rest = rest.slice(1);
      continue;
    }
    out += rest[0] === rest[0].toUpperCase() && rest[0] !== rest[0].toLowerCase() ? hit[1].toUpperCase() : hit[1];
    rest = rest.slice(hit[0].length);
  }
  return out;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
