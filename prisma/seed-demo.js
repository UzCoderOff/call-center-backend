// Fills a DEVELOPMENT database with realistic-looking demo data: offices,
// positions and daily report forms; call-center staff with ~30 days of calls
// (including missed calls, callbacks and unanswered callback attempts);
// office staff (translation, document services) with ~10 days of reports;
// and a boss account — so every screen of the portal has something to show.
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
  { key: "operator", name: "Call-markaz operatori", collectCalls: true, calendarAccess: "book", template: "callcenter" },
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
    const data = { collectCalls: p.collectCalls, calendarAccess: p.calendarAccess, reportTemplateId: templates[p.template].id };
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
    if (!template) continue;
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

  console.log(`Demo data ready: ${employees.length} employees, ${created} calls, ${changed} missed calls resolved, ${reportCount} reports, ${appointmentCount} appointments.`);
  console.log(`Logins: ${BOSS_USERNAME} (BOSS), ${EMPLOYEES.map((e) => e.username).join(", ")} (EMPLOYEE) — password from DEMO_PASSWORD.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
