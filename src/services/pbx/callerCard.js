const prisma = require("../../lib/prisma");
const { phoneKey } = require("../../lib/phone");
const { isManager, isLawyer } = require("../../middleware/auth");
const { clientIndexFor, clientLevel } = require("../../lib/clientAccess");
const { hasCalls } = require("../../lib/calling");
const { isCoordinator } = require("../../lib/jobs");
const { isExtension } = require("./numbers");

// What the call screen in the Ledger app shows about the other side
// (GET /api/device/caller): a colleague by phone ID; a client — their cases
// (what about, how far along, who handles it) and the next step — as much as
// this person may see of that client (src/lib/clientAccess.js); someone
// else's client as just whose; or a new number. Plus what they may do from
// the call: open the client, add them as a client, book a consultation.
//
// The app has no translations of its own for these, so the words are here
// (Uzbek, like the app).

const STATUS = {
  consultation: "Konsultatsiya",
  call_again: "Qayta qoʻngʻiroq",
  contract: "Shartnoma tuzildi",
  done: "Ish tugallandi",
  declined: "Davom etmadi",
};
const STAGE = {
  inquiry: "Surishtiruv",
  investigation: "Tergov harakatlari",
  sent_to_court: "Sudga yuborildi",
  first_instance: "Birinchi instansiya",
  appeal: "Apellyatsiya",
  cassation: "Kassatsiya",
  review: "Taftish",
  supreme_review: "Oliy sud taftishi",
};
const NEXT_STEP = {
  call: "Qoʻngʻiroq",
  decision: "Qarorini kutish",
  meeting: "Uchrashuv",
  documents: "Hujjatlar",
  payment: "Toʻlov",
  other: "Boshqa",
};
const RELATION = {
  father: "otasi",
  mother: "onasi",
  spouse: "turmush oʻrtogʻi",
  child: "farzandi",
  sibling: "aka-ukasi / opa-singlisi",
  relative: "qarindoshi",
  representative: "vakili",
  friend: "doʻsti",
  colleague: "hamkasbi",
};

// The line's own numbers (extensions.conf): the company line and the tests.
const SERVICE = {
  500: "Firma liniyasi",
  600: "Ovozni tekshirish",
  601: "Sinov qoʻngʻirogʻi",
  602: "Sinov: yangi raqam",
};

const canBook = (user) => isManager(user) || user.employee?.calendarAccess === "book";
const canAddClient = (user) =>
  isManager(user) || isLawyer(user) || hasCalls(user.employee) || user.employee?.calendarAccess === "book" || isCoordinator(user.employee);

async function callerCard(user, number) {
  const raw = String(number ?? "").trim();
  const actions = { canBook: canBook(user), canAddClient: canAddClient(user) };

  if (SERVICE[raw]) return { kind: "service", name: SERVICE[raw], ...actions, canBook: false, canAddClient: false };

  // A colleague calling through the line by phone ID.
  if (isExtension(raw)) {
    const row = await prisma.pbxExtension.findUnique({ where: { ext: raw }, include: { employee: { include: { position: { select: { name: true } } } } } });
    if (row) return { kind: "colleague", name: row.employee.name, detail: row.employee.position?.name || null, ...actions, canBook: false, canAddClient: false };
  }

  const key = phoneKey(raw);
  if (!key) return { kind: "unknown", ...actions, canAddClient: false };
  const found = (await clientIndexFor(user, [key])).get(key);
  if (!found) return { kind: "unknown", ...actions };
  if (found.restricted) {
    const owner = found.coordinator ? `Koordinator: ${found.coordinator}` : found.operator ? `Operator: ${found.operator}` : null;
    return { kind: "restricted", detail: owner, ...actions, canAddClient: false };
  }

  const client = await prisma.client.findUnique({
    where: { id: found.id },
    include: {
      cases: {
        orderBy: { updatedAt: "desc" },
        include: {
          operator: { select: { name: true } },
          coordinator: { select: { name: true } },
          lawyerAccount: { select: { name: true, username: true } },
          extraLawyers: { select: { userId: true } },
        },
      },
      followUps: { where: { status: "open" }, orderBy: { dueAt: "asc" }, take: 1 },
    },
  });
  if (!client) return { kind: "unknown", ...actions };
  const { roles } = clientLevel(user, client);
  const cases = client.cases
    .filter((k) => roles.has(k.id) || isManager(user))
    .slice(0, 3)
    .map((k) => {
      const result = roles.get(k.id) === "result";
      const lawyer = k.lawyerAccount?.name || k.lawyerAccount?.username || k.lawyer;
      const people = result
        ? [k.coordinator?.name && `Koordinator: ${k.coordinator.name}`]
        : [k.operator?.name && `Operator: ${k.operator.name}`, lawyer && `Advokat: ${lawyer}`, k.coordinator?.name && `Koordinator: ${k.coordinator.name}`];
      return {
        title: result ? null : k.matter || null,
        status: STATUS[k.status] || k.status,
        stage: result ? null : STAGE[k.legalStage] || null,
        people: people.filter(Boolean).join(" · ") || null,
      };
    });
  const step = client.followUps[0];
  return {
    kind: "client",
    clientId: client.id,
    name: client.name,
    // The number is a relative's or a representative's, not the client's own.
    via: found.contact ? [found.contact.name, RELATION[found.contact.relation] || null].filter(Boolean).join(", ") : null,
    cases,
    nextStep: step ? { what: NEXT_STEP[step.kind] || step.kind, dueAt: step.dueAt, note: step.note } : null,
    ...actions,
    canAddClient: false,
  };
}

module.exports = { callerCard, STATUS, STAGE };
