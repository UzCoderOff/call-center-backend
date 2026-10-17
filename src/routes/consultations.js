const express = require("express");
const prisma = require("../lib/prisma");
const { requireAuth, isManager } = require("../middleware/auth");
const { badRequest, parseId } = require("../utils/params");
const { firmNow } = require("../lib/firmTime");
const { accessibleClientIds, requireClientAccess } = require("../lib/clientAccess");
const s = require("../services/consultSummary");

// Consultation summaries ("suhbat yakuni") — the rules are in
// services/consultSummary.js.
//
//   GET   /api/consultations/missing?scope=mine|team   consultations still
//                                                      without a summary (team: managers)
//   GET   /api/consultations/:id                       one, for its summary page
//   POST  /api/consultations/:id/summary               { topic?, advice?, conclusion,
//                                                        prospect, next? | lostReason, caseId? }
//   PATCH /api/consultations/:id/summary               correct its texts
//   POST  /api/consultations/:id/draft                 { notes } — Claude drafts the
//                                                      summary from rough notes (not saved)
//   GET   /api/consultations/rule                      the strike rule (managers change it)
//   PUT   /api/consultations/rule                      { enabled?, hours?, limit? } (managers)
//   GET   /api/consultations/strikes?month=YYYY-MM     managers: everyone's; others: their own
//   POST  /api/consultations/strikes/:id/cancel        { reason } (managers)
const router = express.Router();
router.use(requireAuth);

const PERSON = { select: { id: true, username: true, name: true, employee: { select: { name: true } } } };

function sendError(err, res, next) {
  if (err instanceof s.SummaryError || (err.status && err.status < 500)) return res.status(err.status || 400).json({ error: err.message });
  return next(err);
}

const LIST_SELECT = {
  id: true,
  date: true,
  start: true,
  end: true,
  status: true,
  walkIn: true,
  createdAt: true,
  format: true,
  clientName: true,
  clientPhone: true,
  clientId: true,
  matter: true,
  calendar: { select: { id: true, name: true, ownerId: true } },
  bookedBy: PERSON,
};

router.get("/missing", async (req, res, next) => {
  try {
    const team = req.query.scope === "team" && isManager(req.user);
    const rule = await s.summaryRule();
    const now = firmNow();
    const rows = await prisma.appointment.findMany({
      where: { ...s.missingWhere(rule, now), ...(team ? {} : { calendar: { active: true, ownerId: req.user.id } }) },
      orderBy: [{ date: "asc" }, { start: "asc" }],
      take: 200,
      select: LIST_SELECT,
    });
    res.json({
      rule: { enabled: rule.enabled, hours: rule.hours },
      items: rows.map((a) => ({ ...a, deadlineAt: s.deadlineFor(a, rule) })),
    });
  } catch (err) {
    sendError(err, res, next);
  }
});

// ------------------------------------------------------------ the rule
router.get("/rule", async (req, res, next) => {
  try {
    const rule = await s.summaryRule();
    res.json({ ...rule, canEdit: isManager(req.user) });
  } catch (err) {
    sendError(err, res, next);
  }
});

router.put("/rule", async (req, res, next) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    const { setSetting } = require("../lib/settings");
    const next_ = s.normalizeRule(req.body, await s.summaryRule());
    await setSetting("summaryRule", next_, req.user.id);
    res.json({ ...next_, canEdit: true });
  } catch (err) {
    sendError(err, res, next);
  }
});

// ------------------------------------------------------------ strikes
router.get("/strikes", async (req, res, next) => {
  try {
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month || "") ? req.query.month : firmNow().date.slice(0, 7);
    const rows = await prisma.summaryStrike.findMany({
      where: { month, ...(isManager(req.user) ? {} : { userId: req.user.id }) },
      orderBy: { deadlineAt: "desc" },
      include: { user: PERSON, cancelledBy: PERSON, appointment: { select: { id: true, date: true, start: true, clientName: true, clientId: true, summaryAt: true } } },
    });
    const rule = await s.summaryRule();
    res.json({ month, limit: rule.limit, strikes: rows });
  } catch (err) {
    sendError(err, res, next);
  }
});

router.post("/strikes/:id/cancel", async (req, res, next) => {
  try {
    if (!isManager(req.user)) return res.status(403).json({ error: "forbidden" });
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 300) : "";
    if (!reason) throw badRequest("reason is required");
    const strike = await prisma.summaryStrike.findUnique({ where: { id: parseId(req.params.id) } });
    if (!strike) return res.status(404).json({ error: "not_found" });
    if (strike.cancelledAt) return res.json(strike);
    res.json(await prisma.summaryStrike.update({ where: { id: strike.id }, data: { cancelledAt: new Date(), cancelledById: req.user.id, cancelReason: reason } }));
  } catch (err) {
    sendError(err, res, next);
  }
});

// ------------------------------------------------------------ one
// Whoever may see it: the specialist, managers, whoever booked it, or
// someone who may open its client.
async function loadFor(user, id) {
  const a = await prisma.appointment.findUnique({
    where: { id },
    include: {
      calendar: { select: { id: true, name: true, ownerId: true } },
      bookedBy: PERSON,
      summaryBy: PERSON,
      case: { select: { id: true, matter: true, details: true, status: true } },
    },
  });
  if (!a) throw Object.assign(new Error("not_found"), { status: 404 });
  const writer = s.mayWrite(user, a);
  const viewer = writer || a.bookedById === user.id || (a.clientId && (await accessibleClientIds(user, [a.clientId])).has(a.clientId));
  if (!viewer) throw Object.assign(new Error("not_found"), { status: 404 });
  return { a, writer };
}

router.get("/:id", async (req, res, next) => {
  try {
    const { a: appointment, writer } = await loadFor(req.user, parseId(req.params.id));
    let a = appointment;
    // The specialist who held it (and managers): its client's cases and
    // people, to pick from. Anyone else (whoever booked it, the client's
    // operator or coordinator): only the cases they work on — someone who
    // only sees a past result, or no case, gets the appointment without the
    // summary.
    let visibleCase = () => writer;
    let level = writer ? "writer" : null;
    if (!writer && a.clientId) {
      const access = await requireClientAccess(req.user, a.clientId).catch(() => null);
      level = access?.level ?? null;
      visibleCase = (caseId) => Boolean(access) && (access.level === "manager" || (access.roles.get(caseId) && access.roles.get(caseId) !== "result"));
    }
    const summaryShown = writer || (a.caseId ? visibleCase(a.caseId) : level != null && level !== "result");
    if (!summaryShown) a = { ...a, summary: null, case: null };
    else if (a.case && !visibleCase(a.case.id)) a = { ...a, case: null };
    const [allCases, contacts] = a.clientId
      ? await Promise.all([
          prisma.clientCase.findMany({
            where: { clientId: a.clientId },
            orderBy: { updatedAt: "desc" },
            select: { id: true, matter: true, details: true, status: true, operator: { select: { id: true, name: true } } },
          }),
          writer || (level && level !== "result")
            ? prisma.clientContact.findMany({ where: { clientId: a.clientId, deletedAt: null }, select: { id: true, name: true, relation: true, decides: true } })
            : [],
        ])
      : [[], []];
    const cases = allCases.filter((k) => visibleCase(k.id));
    const now = firmNow();
    res.json({
      ...a,
      over: s.isOver(a, now),
      needsSummary: s.needsSummary(a, now),
      canWrite: writer && !a.summaryAt && !["cancelled", "no_show"].includes(a.status),
      canEdit: Boolean(a.summaryAt) && (a.summaryById === req.user.id || isManager(req.user)),
      canMarkNoShow: (a.calendar.ownerId === req.user.id || req.user.role === "DEVELOPER") && a.status === "booked",
      cases,
      contacts,
    });
  } catch (err) {
    sendError(err, res, next);
  }
});

router.post("/:id/summary", async (req, res, next) => {
  try {
    const caseId = req.body?.caseId == null || req.body.caseId === "" ? undefined : parseId(req.body.caseId, "caseId");
    const result = await s.saveSummary(prisma, { appointmentId: parseId(req.params.id), user: req.user, input: req.body, caseId });
    res.status(201).json(result);
  } catch (err) {
    sendError(err, res, next);
  }
});

// The specialist types a few rough lines; Claude turns them into the
// summary's fields for them to check and save (nothing is saved here).
const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topic", "advice", "conclusion", "prospect", "nextKind", "nextInDays", "lostReason"],
  properties: {
    topic: { type: "string" },
    advice: { type: "string" },
    conclusion: { type: "string" },
    prospect: { type: "string", enum: ["potential", "not_potential", "unknown"] },
    nextKind: { type: "string", enum: ["decision", "call", "meeting", "contract", "none"] },
    nextInDays: { anyOf: [{ type: "integer" }, { type: "null" }] },
    lostReason: { anyOf: [{ type: "string", enum: require("../services/clients").LOST_REASONS }, { type: "null" }] },
  },
};

router.post("/:id/draft", async (req, res, next) => {
  try {
    const { claudeFeatureOn } = require("../services/ai/settings");
    if (!(await claudeFeatureOn("summaryDraft"))) return res.status(409).json({ error: "ai_off" });
    const { a, writer } = await loadFor(req.user, parseId(req.params.id));
    if (!writer) return res.status(403).json({ error: "forbidden" });
    const notes = typeof req.body?.notes === "string" ? req.body.notes.trim().slice(0, 4000) : "";
    if (notes.length < 5) return res.status(400).json({ error: "notes_required" });
    const claude = require("../services/ai/claude");
    const system = [
      "Siz yuridik firmada advokatning yordamchisisiz. Advokat konsultatsiyadan keyin qisqa, tartibsiz yozuv qoldirdi. Undan «Suhbat yakuni» maydonlarini toʻldiring:",
      "- topic: mijoz qanday masala bilan kelgan (1–2 jumla).",
      "- advice: qanday maslahat/yechim berilgan, narx haqida nima deyilgan (agar yozilgan boʻlsa).",
      "- conclusion: suhbat yakuni — nima kelishildi, mijoz nima dedi (1–3 jumla).",
      "- prospect: potential (shartnoma tuzishi mumkin), not_potential (tuzmaydi) yoki unknown (yozuvdan bilinmaydi).",
      "- nextKind: decision (oʻylab koʻradi / oilasi bilan maslahatlashadi), call (qayta qoʻngʻiroq), meeting (yana keladi), contract (shartnoma tuzdi), none.",
      "- nextInDays: keyingi qadam necha kundan keyin (yozuvda aytilgan boʻlsa, aks holda null).",
      "- lostReason: not_potential boʻlsa sabab (price, thinking, trust, other_lawyer, unreachable, no_need, not_our_field, other), aks holda null.",
      "Faqat yozuvdagi maʼlumotdan foydalaning, qoʻshimcha fakt oʻylab topmang. Oʻzbek tilida, lotin yozuvida, toza va xushmuomala yozing.",
    ].join("\n");
    const context = `Uchrashuv: ${a.date}, mijoz: ${a.clientName}. Yozilgan masala: ${a.matter || "—"}.`;
    const response = await claude.create(
      { system, messages: [{ role: "user", content: `${context}\n\nAdvokatning yozuvi:\n${notes}` }], output_config: { effort: "low", format: { type: "json_schema", schema: DRAFT_SCHEMA } } },
      { feature: "summaryDraft" }
    );
    const draft = claude.jsonOf(response);
    if (!draft) return res.status(422).json({ error: "no_draft" });
    res.json(draft);
  } catch (err) {
    if (err.code === "claude_off" || err.code === "claude_cap") return res.status(409).json({ error: err.code });
    sendError(err, res, next);
  }
});

router.patch("/:id/summary", async (req, res, next) => {
  try {
    res.json(await s.updateSummaryText(prisma, { appointmentId: parseId(req.params.id), user: req.user, input: req.body }));
  } catch (err) {
    sendError(err, res, next);
  }
});

module.exports = router;
