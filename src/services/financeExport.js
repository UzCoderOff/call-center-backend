// The Moliya month as an Excel workbook (routes/finance.js /export): the
// same figures as the page, one sheet per part, in Uzbek like the portal.

const KIND = { consultation: "Konsultatsiya", contract: "Shartnoma", other: "Boshqa" };
const METHOD = { cash: "Naqd", card: "Karta", transfer: "Oʻtkazma", none: "Koʻrsatilmagan" };
const SOURCE = { call: "Qoʻngʻiroq", telegram: "Telegram", instagram: "Instagram", referral: "Tavsiya", walk_in: "Oʻzi keldi", other: "Boshqa", none: "Koʻrsatilmagan" };
const STATUS = { booked: "Belgilanmagan", attended: "Keldi", no_show: "Kelmadi", cancelled: "Bekor" };
const AWAY = { income: "Tushum", expense: "Xarajat" };

const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// data: financeData(); cash: cashBalances() or null.
function financeSheets(data, cash) {
  const s = data.summary;
  const c = data.sources.clients;
  const firm = data.scope === "firm";
  const sheets = [];

  const summary = [
    ["Koʻrsatkich", "Summa (soʻm)", "Izoh"],
    ["Oy", data.month, firm ? "Butun firma" : "Faqat sizning ishlaringiz"],
    ["Jami tushum", s.income, "mijoz toʻlovlari + hisobotdagi «Tushum»"],
    ["  Mijozlardan toʻlovlar", c.total, `${c.count} ta toʻlov`],
    ["    Konsultatsiya toʻlovlari", c.kinds.consultation.amount, `${c.kinds.consultation.count} ta`],
    ["    Shartnoma toʻlovlari", c.kinds.contract.amount, `${c.kinds.contract.count} ta`],
    ["      shu oy tuzilgan shartnomalar", c.contractSplit.newContracts.amount, `${c.contractSplit.newContracts.count} ta`],
    ["      avvalgi shartnomalar", c.contractSplit.earlier.amount, `${c.contractSplit.earlier.count} ta`],
    ["    Boshqa toʻlovlar", c.kinds.other.amount, `${c.kinds.other.count} ta`],
  ];
  if (firm) {
    summary.push(["  Xodimlar hisobotlaridan", s.reportIncome, ""]);
    summary.push(["Xarajatlar (hisobotlardan)", s.expenses, ""]);
    summary.push(["Sof tushum", s.net, "jami tushum − xarajatlar"]);
  }
  summary.push(
    ["Yangi shartnomalar", s.contracted, `${s.contractCount} ta`],
    ["Qarzdorlik (bugun)", s.owed, `${s.owedClients} ta mijoz`],
    ["  muddati oʻtgan (jadval boʻyicha)", data.owed.plan.overdue, `${data.owed.plan.overdueCases} ta shartnoma`],
    ["  14 kun ichida", data.owed.plan.dueSoon, ""],
    ["  keyinroq (jadval boʻyicha)", data.owed.plan.later, ""],
    ["  toʻlov jadvalisiz", data.owed.plan.unscheduled, ""],
    ["Oʻtgan oy: jami tushum", s.prev.income, ""],
    ["Oʻtgan oy: yangi shartnomalar", s.prev.contracted, ""]
  );
  sheets.push({ name: "Umumiy", rows: summary, widths: [38, 18, 40] });

  sheets.push({
    name: "Toʻlovlar",
    rows: [
      ["Sana", "Mijoz", "Nima uchun", "Usul", "Summa", "Advokat", "Masala", "Kiritdi", "Onlayn", "Izoh"],
      ...data.payments.map((p) => [p.date, p.client.name, KIND[p.kind] || p.kind || "", METHOD[p.method || "none"], p.amount, p.lawyer || "", p.matter || "", p.recordedBy || "", p.format === "online" ? "ha" : "", p.note || ""]),
    ],
    widths: [12, 28, 14, 14, 14, 22, 26, 20, 8, 30],
  });

  if (firm && data.sources.reports) {
    sheets.push({
      name: "Hisobot pullari",
      rows: [
        ["Sana", "Xodim", "Shakl", "Savol", "Ustun", "Xizmat", "Turi", "Summa"],
        ...data.reportEntries.map((e) => [e.date, e.person || "", e.form || "", e.label, e.column || "", e.service || "", AWAY[e.kind], e.amount]),
      ],
      widths: [12, 22, 24, 28, 18, 20, 10, 14],
    });
    if (data.sources.reports.unclassified.length) {
      sheets.push({
        name: "Belgilanmagan",
        rows: [["Shakl", "Savol", "Ustun", "Summa", "Necha marta"], ...data.sources.reports.unclassified.map((u) => [u.form || "", u.label, u.column || "", u.amount, u.count])],
        widths: [26, 30, 18, 14, 12],
      });
    }
  }

  if (data.sources.channels) {
    sheets.push({
      name: "Manbalar",
      rows: [
        ["Mijoz qayerdan", "Yangi mijozlar", "Konsultatsiyalar", "Shartnomalar", "Shartnoma summasi", "Tushum"],
        ...data.sources.channels.map((ch) => [SOURCE[ch.source] || ch.source, ch.newClients, ch.consultations, ch.contracts, ch.contracted, ch.received]),
      ],
      widths: [20, 14, 16, 14, 18, 16],
    });
  }

  sheets.push({
    name: "Shartnomalar",
    rows: [
      ["Sana", "Mijoz", "Advokat", "Masala", "Summa", "Toʻlangan", "Qolgan"],
      ...data.contracts.list.map((k) => [k.date, k.client.name, k.lawyer || "", k.matter || "", k.amount, k.paid, k.remaining]),
    ],
    widths: [12, 28, 22, 28, 14, 14, 14],
  });

  sheets.push({
    name: "Qarzlar",
    rows: [
      ["Mijoz", "Advokat", "Shartnoma sanasi", "Oxirgi toʻlov", "Shartnoma", "Toʻlangan", "Qarz"],
      ...data.owed.top.map((o) => [o.client.name, o.lawyers.join(", "), o.since || "", o.lastPayment || "", o.contracted, o.paid, o.owed]),
    ],
    widths: [28, 26, 16, 14, 14, 14, 14],
  });

  sheets.push({
    name: "Muddati oʻtgan",
    rows: [
      ["Mijoz", "Advokat", "Qachondan", "Necha kun", "Muddati oʻtgan summa", "Keyingi toʻlov", "Keyingi summa"],
      ...data.owed.overdueList.map((o) => [o.client.name, o.lawyer || "", o.since, o.daysLate, o.amount, o.next?.dueDate || "", o.next?.left ?? ""]),
    ],
    widths: [28, 22, 12, 10, 20, 14, 14],
  });

  sheets.push({
    name: "Advokatlar",
    rows: [
      ["Advokat", "Konsultatsiyalar", "Keldi", "Shartnomalar", "Shartnoma summasi", "Tushum", "  konsultatsiya", "  shartnoma", "Qarz"],
      ...data.lawyers.map((l) => [l.lawyer || "Biriktirilmagan", l.consultations, l.attended, l.contracts, l.contracted, l.received, l.consultationFees, l.contractPayments, l.owed]),
    ],
    widths: [24, 16, 8, 12, 18, 14, 14, 14, 14],
  });

  sheets.push({
    name: "Toʻlovsiz konsultatsiya",
    rows: [
      ["Sana", "Vaqt", "Mijoz", "Advokat", "Onlayn", "Holati"],
      ...data.consultations.unpaidHeld.map((a) => [a.date, clock(a.start), a.clientName, a.lawyer || "", a.format === "online" ? "ha" : "", STATUS[a.status] || a.status]),
    ],
    widths: [12, 8, 28, 22, 8, 14],
  });

  if (cash) {
    sheets.push({
      name: "Kassa",
      rows: [["Kim", "Olgan naqd", "Toʻlovlar", "Topshirgan", "Qoʻlida", "Oxirgi topshirish"], ...cash.map((p) => [p.user.name, p.taken, p.payments, p.handed, p.holding, p.lastHandover || ""])],
      widths: [24, 14, 10, 14, 14, 16],
    });
  }
  return sheets;
}

module.exports = { financeSheets };
