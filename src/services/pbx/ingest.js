const fs = require("fs");
const path = require("path");
const prisma = require("../../lib/prisma");
const env = require("../../config/env");
const { phoneKey } = require("../../lib/phone");
const { events } = require("../../lib/events");
const { reconcileFollowUps } = require("../followUp");
const { transcodeToMp3, PHONE_LINE_AUDIO } = require("../../utils/audioTranscode");
const { hasJob } = require("../../lib/jobs");
const { normalizeUz } = require("./numbers");
const { pbxSettings, savePbxSettings } = require("./settings");
const presence = require("./presence");

// Calls on Ledger's phone line, into Ledger. When a call ends, the dialplan
// (pbx/asterisk/extensions.conf) leaves small files in PBX_SPOOL_DIR, one line
// of key=value&… each:
//
//   <call>.call.evt           the call: dir (in | out), num (the outside
//                             number), ext (out: who called), start, end
//                             (epoch seconds), status, talk (seconds), rec
//                             (the recording's file name in PBX_MONITOR_DIR),
//                             vm (night | busy: the caller was asked to leave
//                             a message, <call>.vm.wav in PBX_MONITOR_DIR)
//   <call>.ring-<ext>-<n>.evt each time a phone was rung for it: ext, rs
//                             (when), waited (seconds the phone took to come
//                             up), status (ANSWER, NOANSWER, WAKE_TIMEOUT…),
//                             talk, kind (queue | direct | internal), note
//                             (the line's word on it: "direct" a coordinator's
//                             client, "mine:<why>" an operator's caller…)
//
// Files survive a backend restart (a deploy stops it for a minute); they're
// picked up here, a call becomes a CallLog row (source "pbx") just like one
// synced from a phone — same call-back list, Telegram, reports, strikes —
// and its recording becomes a small MP3 next to the phone recordings.

const SETTLE_MS = 3000; // a call's ring files may land just after it
const ORPHAN_RING_MS = 10 * 60 * 1000;
const MIN_RECORDING_BYTES = 44 + 16000; // WAV header + 1 s of 8 kHz audio
// A message shorter than a second and a half is someone hanging up at the beep.
const MIN_MESSAGE_BYTES = 44 + 24000;

const parseEvt = (text) => Object.fromEntries(new URLSearchParams(String(text).trim()));

// The outside number as stored on a call: +998… when it's Uzbek, the digits
// otherwise, "" when hidden.
function storedNumber(raw) {
  const text = String(raw ?? "").trim();
  if (!/\d/.test(text) || /anonymous|unknown|restricted/i.test(text)) return "";
  const uz = normalizeUz(text);
  return uz.e164 || text.replace(/[^\d+]/g, "");
}

// Pure: a call's files -> what to store, or null when it belongs to nobody.
//   employeeByExt  Map<ext, employeeId> (everyone who has a phone ID)
//   pickRotation   () -> employeeId for a missed call nobody was rung for
function summarizeCall(call, rings, { employeeByExt, pickRotation }) {
  const start = Number(call.start) || 0;
  const phoneNumber = storedNumber(call.num);
  const base = { callTimestampMs: start * 1000, phoneNumber };

  if (call.dir === "out") {
    const employeeId = employeeByExt.get(call.ext) ?? null;
    if (!employeeId) return null;
    const answered = call.status === "ANSWER";
    return {
      ...base,
      employeeId,
      callType: "outgoing",
      missed: false,
      durationSeconds: answered ? Math.max(0, Number(call.talk) || 0) : 0,
      answered,
      detail: { owner: "caller", status: call.status || null },
    };
  }

  const rang = rings
    .slice()
    .sort((a, b) => (Number(a.rs) || 0) - (Number(b.rs) || 0))
    .map((r) => ({
      ext: r.ext,
      employeeId: employeeByExt.get(r.ext) ?? null,
      status: r.status || "",
      waitedSec: Number(r.waited) || 0,
      talkSec: Number(r.talk) || 0,
      kind: r.kind || null,
      ...(r.note ? { note: r.note } : {}),
    }));
  const queueWaitSec = Math.max(0, (Number(call.end) || start) - start);
  // Rung straight away (route.js): a client in work's coordinator, or the
  // operator whose caller it is ("mine:…" — thinking, second chance, talked
  // to them last). Rings from before the note was kept were coordinators'.
  const directRing = rang.find((r) => r.kind === "direct");
  const direct = directRing
    ? { ext: directRing.ext, employeeId: directRing.employeeId, answered: directRing.status === "ANSWER", status: directRing.status, coordinator: !directRing.note || directRing.note === "direct" }
    : null;
  const answer = rang.find((r) => r.status === "ANSWER" && r.employeeId);
  if (answer) {
    // Passed on to colleagues ([ledger-transfer]): the call stays the
    // operator's who answered it; whom it went to — and from whom, the last
    // person who had answered before — is kept with it.
    const transfers = [];
    let holder = null;
    for (const r of rang) {
      if (r.kind === "transfer") transfers.push({ ext: r.ext, employeeId: r.employeeId, fromEmployeeId: holder, answered: r.status === "ANSWER", status: r.status, talkSec: r.talkSec });
      if (r.status === "ANSWER" && r.employeeId) holder = r.employeeId;
    }
    // Their talk in all: a call passed on can come back to them.
    const talk = rang.filter((r) => r.status === "ANSWER" && r.employeeId === answer.employeeId).reduce((sum, r) => sum + r.talkSec, 0);
    return {
      ...base,
      employeeId: answer.employeeId,
      callType: "incoming",
      missed: false,
      durationSeconds: talk,
      answered: true,
      detail: { rang, owner: "answered", status: call.status || null, ...(direct ? { direct } : {}), ...(transfers.length ? { transfers } : {}) },
    };
  }
  // Missed: the operator whose turn it was (rung first) owns it — their
  // call-back list, their Telegram, their strike — or, when nobody could be
  // rung at all (outside working hours too), whoever's turn it is in the
  // rotation. A client in work rang their coordinator first: the
  // coordinator's.
  const first = rang.find((r) => r.employeeId);
  const employeeId = first ? first.employeeId : pickRotation();
  if (!employeeId) return null;
  const reason = call.vm === "night" ? "night" : rang.length ? "not_answered" : "nobody_free";
  return {
    ...base,
    employeeId,
    callType: "missed",
    missed: true,
    durationSeconds: 0,
    answered: false,
    detail: { rang, owner: first ? "first_rung" : "rotation", status: call.status || null, reason, queueWaitSec, ...(direct ? { direct } : {}) },
  };
}

// Whose turn it is to own a missed call nobody was rung for: active
// call-center staff on the line, in turn — or, with nobody on the line yet,
// any active call-center staff, so a client's call is never lost.
async function rotationPicker() {
  const callCenter = (await prisma.employee.findMany({ where: { active: true }, select: { id: true, job: true, extraJobs: true, pbxCalling: true }, orderBy: { id: "asc" } })).filter((e) =>
    hasJob(e, "call_center")
  );
  const onLine = callCenter.filter((e) => e.pbxCalling);
  const people = onLine.length ? onLine : callCenter;
  let next = (await pbxSettings()).rotation || 0;
  let saved = next;
  return {
    pick: () => (people.length ? people[next++ % people.length].id : null),
    save: async () => {
      if (next === saved) return;
      saved = next;
      await savePbxSettings({ rotation: next });
    },
  };
}

const callIdOf = (file) => file.replace(/\.call\.evt$/, "");
const safeId = (id) => /^[\w.-]{1,64}$/.test(id);

function readEvt(file) {
  return parseEvt(fs.readFileSync(path.join(env.pbx.spoolDir, file), "utf8"));
}

function removeQuietly(file) {
  fs.rm(file, { force: true }, () => {});
}

// Turns the recording into an MP3 next to the phone recordings; returns
// { recordingPath, recordingFilename } or {} when there's nothing to keep.
async function saveRecording(rec, { employeeId, callTimestampMs, callId, answered }) {
  if (!rec || !/^[\w.-]+\.wav$/.test(rec)) return {};
  const wav = path.join(env.pbx.monitorDir, rec);
  let size = 0;
  try {
    size = fs.statSync(wav).size;
  } catch {
    return {};
  }
  if (!answered || size < MIN_RECORDING_BYTES) {
    removeQuietly(wav);
    return {};
  }
  const name = `${callTimestampMs}-pbx-${callId.replace(/[^\w-]/g, "_")}.mp3`;
  const relative = path.join(String(employeeId), name);
  await transcodeToMp3(wav, path.join(env.storageRoot, relative), PHONE_LINE_AUDIO);
  removeQuietly(wav);
  return { recordingPath: relative, recordingFilename: name };
}

// The message a caller left ([line-message]): kept as the missed call's
// recording, so whoever calls back hears their name and problem first.
// -> { recordingPath, recordingFilename, seconds, wav } (the WAV stays for
// the transcriber, transcribe.js queueMessage) or null.
async function saveMessage(callId, { employeeId, callTimestampMs }) {
  const wav = path.join(env.pbx.monitorDir, `${callId}.vm.wav`);
  let size = 0;
  try {
    size = fs.statSync(wav).size;
  } catch {
    return null;
  }
  if (size < MIN_MESSAGE_BYTES) {
    removeQuietly(wav);
    return null;
  }
  const name = `${callTimestampMs}-pbx-${callId.replace(/[^\w-]/g, "_")}.mp3`;
  const relative = path.join(String(employeeId), name);
  await transcodeToMp3(wav, path.join(env.storageRoot, relative), PHONE_LINE_AUDIO);
  return { recordingPath: relative, recordingFilename: name, seconds: Math.round((size - 44) / 16000), wav };
}

// The names on a call's transfers (the portal shows "Aziza'ga ulandi").
async function nameTransfers(transfers) {
  const ids = [...new Set(transfers.flatMap((t) => [t.employeeId, t.fromEmployeeId]).filter(Boolean))];
  const names = new Map((await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
  for (const t of transfers) {
    t.name = names.get(t.employeeId) || null;
    t.fromName = names.get(t.fromEmployeeId) || null;
  }
}

// Who should have taken a client's call and didn't, while someone else did:
// a colleague it was passed to, or the coordinator a client in work was sent
// straight to. [{ employeeId, fromEmployeeId, notes }] — once each, and not
// if they got the call on another try. A call nobody answered is a missed
// call instead (its own call-back list and alerts). An operator rung first
// for their own caller isn't sent to call back: a colleague talked to them
// (ringNotices says so).
function missedBy(summary) {
  if (summary.missed) return [];
  const { transfers = [], direct, rang = [] } = summary.detail;
  const answered = new Set(rang.filter((r) => r.status === "ANSWER").map((r) => r.employeeId));
  const out = [];
  const seen = new Set();
  const add = (employeeId, item) => {
    if (!employeeId || answered.has(employeeId) || seen.has(employeeId)) return;
    seen.add(employeeId);
    out.push({ employeeId, ...item });
  };
  if (direct && !direct.answered && direct.coordinator !== false) {
    add(direct.employeeId, { fromEmployeeId: summary.employeeId, notes: "Mijozingiz qoʻngʻiroq qildi — javob bermadingiz, qoʻngʻiroqni call-markaz oldi. Mijozga qoʻngʻiroq qiling." });
  }
  for (const t of transfers) {
    if (t.answered) continue;
    add(t.employeeId, { fromEmployeeId: t.fromEmployeeId, notes: `${t.fromName || "Hamkasbingiz"} bu mijozning qoʻngʻirogʻini sizga ulagan edi — javob berilmadi. Mijozga qoʻngʻiroq qiling.` });
  }
  return out;
}

// Everyone whose phone rang for a client's call and who didn't pick up (the
// firm's ask, 2026-10-27: "mark whether the caller was answered by someone
// else or not"), each told once: [{ employeeId, answeredBy, owner }] —
// answeredBy who took it (null: nobody), owner whose call-back list a missed
// call is on. Not those reminded to call back instead (missedBy).
function ringNotices(summary) {
  const rang = summary.detail.rang || [];
  const answered = summary.missed ? null : summary.employeeId;
  const reminded = new Set(missedBy(summary).map((m) => m.employeeId));
  const tookIt = new Set(rang.filter((r) => r.status === "ANSWER").map((r) => r.employeeId));
  const out = [];
  for (const r of rang) {
    if (!r.employeeId || tookIt.has(r.employeeId) || reminded.has(r.employeeId) || out.some((o) => o.employeeId === r.employeeId)) continue;
    out.push({ employeeId: r.employeeId, answeredBy: answered, owner: summary.missed ? summary.employeeId : null });
  }
  return out;
}

// Tells them (the bell and their phone): someone else talked to the caller —
// no need to call back; or nobody did — the owner calls back.
async function sendRingNotices(people, { phone, callId }) {
  if (!people.length) return;
  const { notifyPush } = require("../notify");
  const { clientIndexFor } = require("../../lib/clientAccess");
  const f = require("../telegram/format");
  const ids = [...new Set(people.flatMap((p) => [p.employeeId, p.answeredBy, p.owner]).filter(Boolean))];
  const names = new Map((await prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((e) => [e.id, e.name]));
  const key = phoneKey(phone);
  for (const p of people) {
    const user = await prisma.user.findFirst({ where: { employee: { id: p.employeeId }, active: true }, include: { employee: true } });
    if (!user) continue;
    const client = key ? (await clientIndexFor(user, [key])).get(key) : null;
    const who = client && !client.restricted ? client.name : f.phone(phone);
    const mine = p.owner === p.employeeId;
    const notice = p.answeredBy
      ? { title: `${who} — ${names.get(p.answeredBy) || "hamkasbingiz"} javob berdi`, body: "Bu qoʻngʻiroq sizga ham kelgan edi. Qayta qoʻngʻiroq qilish shart emas." }
      : {
          title: `${who} — hech kim javob bermadi`,
          body: mine ? "Qayta qoʻngʻiroq qiling." : `Qayta qoʻngʻiroqni ${names.get(p.owner) || "navbatdagi operator"} qiladi.`,
          ...(mine ? { phone } : {}),
        };
    await notifyPush(user.id, { ...notice, kind: "missedCalls", tag: `ring:${callId}` });
  }
}

// A reminder, now, to call the client back — so the client never has to call
// again.
async function remindUnanswered(people, phone) {
  const { planOne, REMINDER_INCLUDE } = require("../reminders");
  const { clientIndexFor } = require("../../lib/clientAccess");
  for (const t of people) {
    const user = await prisma.user.findFirst({ where: { employee: { id: t.employeeId }, active: true }, include: { employee: true } });
    if (!user) continue;
    const from = t.fromEmployeeId ? await prisma.user.findFirst({ where: { employee: { id: t.fromEmployeeId } }, select: { id: true } }) : null;
    const key = phoneKey(phone);
    const client = key ? (await clientIndexFor(user, [key])).get(key) : null;
    const known = client && !client.restricted ? client : null;
    const row = await prisma.reminder.create({
      data: {
        userId: user.id,
        createdById: from?.id ?? null,
        title: `Qayta qoʻngʻiroq: ${known?.name || phone}`.slice(0, 200),
        notes: t.notes,
        dueAt: new Date(),
        phone: String(phone).slice(0, 40),
        clientId: known?.id ?? null,
      },
      include: REMINDER_INCLUDE,
    });
    planOne(row);
  }
}

async function processCall(callId, ringFiles, rotation) {
  const call = readEvt(`${callId}.call.evt`);
  const rings = ringFiles.map(readEvt);
  await presence.noteCallRings(rings);

  const exts = await prisma.pbxExtension.findMany({ select: { ext: true, employeeId: true } });
  const summary = summarizeCall(call, rings, { employeeByExt: new Map(exts.map((e) => [e.ext, e.employeeId])), pickRotation: rotation.pick });
  if (!summary) {
    console.warn(`[pbx] call ${callId} (${call.dir || "?"}, ${call.num || "no number"}) belongs to nobody — no call-center staff and no known phone ID; not kept`);
    if (/^[\w.-]+\.wav$/.test(call.rec || "")) removeQuietly(path.join(env.pbx.monitorDir, call.rec));
    for (const who of ["client", "staff"]) for (const ext of ["wav", "wav16"]) removeQuietly(path.join(env.pbx.monitorDir, `${callId}.${who}.${ext}`));
    removeQuietly(path.join(env.pbx.monitorDir, `${callId}.vm.wav`));
    return null;
  }

  const transfers = summary.detail.transfers || [];
  if (transfers.length) await nameTransfers(transfers);
  const direct = summary.detail.direct;
  if (direct) direct.name = (await prisma.employee.findUnique({ where: { id: direct.employeeId ?? -1 }, select: { name: true } }))?.name || null;
  const isNew = !(await prisma.callLog.findUnique({ where: { pbxCallId: callId }, select: { id: true } }));

  let recording = await saveRecording(call.rec, { ...summary, callId });
  // A missed call with a message: the message is its recording.
  const message = summary.missed && call.vm ? await saveMessage(callId, summary) : null;
  if (message) {
    recording = { recordingPath: message.recordingPath, recordingFilename: message.recordingFilename };
    summary.detail.voicemail = { seconds: message.seconds };
  }
  const key = phoneKey(summary.phoneNumber);
  const fields = {
    employeeId: summary.employeeId,
    phoneNumber: summary.phoneNumber,
    phoneKey: key,
    callType: summary.callType,
    missed: summary.missed,
    durationSeconds: summary.durationSeconds,
    callTimestampMs: BigInt(summary.callTimestampMs),
    syncedAtMs: BigInt(Date.now()),
    source: "pbx",
    pbxDetail: summary.detail,
    ...recording,
  };
  const row = await prisma.callLog.upsert({
    where: { pbxCallId: callId },
    create: { ...fields, pbxCallId: callId, deviceCallLogId: `pbx:${callId}`, followUp: summary.missed ? (key ? "pending" : "no_number") : null },
    update: fields,
    select: { id: true },
  });
  await rotation.save();
  // Each side of the call, kept apart for the transcriber: queued when the
  // call is one the AI reviews (an operator's, long enough), else dropped.
  try {
    const { reviewable } = require("../callReview");
    const employee = await prisma.employee.findUnique({ where: { id: summary.employeeId } });
    await require("./transcribe").queueOrDrop(callId, row, { review: reviewable({ ...summary, employee }) && Boolean(recording.recordingPath) });
    // The caller's message, to read as well as hear.
    if (message) await require("./transcribe").queueMessage(row, message.wav);
  } catch (err) {
    console.error(`[pbx] call ${callId}: queueing it for text failed:`, err.message);
    if (message) removeQuietly(message.wav);
  }
  if (key) {
    try {
      await reconcileFollowUps([key]);
    } catch (err) {
      console.error("[pbx] follow-up reconciliation failed:", err.message);
    }
  }
  // Once per call (not again when it's taken in a second time).
  if (isNew && summary.phoneNumber) {
    try {
      await remindUnanswered(missedBy(summary), summary.phoneNumber);
    } catch (err) {
      console.error("[pbx] transfer reminders failed:", err.message);
    }
    try {
      if (summary.callType !== "outgoing") await sendRingNotices(ringNotices(summary), { phone: summary.phoneNumber, callId });
    } catch (err) {
      console.error("[pbx] ring notices failed:", err.message);
    }
  }
  events.emit("calls.synced", { employeeId: summary.employeeId, callIds: [row.id], recordingCallIds: recording.recordingPath ? [row.id] : [] });
  // Their open Ledger looks again: right after a talk with a new caller it
  // asks what came of it (the portal's AfterCallGate).
  const owner = await prisma.employee.findUnique({ where: { id: summary.employeeId }, select: { userId: true } });
  if (owner?.userId) require("../live").bump([owner.userId]);
  return row.id;
}

let sweeping = null;
function sweep() {
  if (!sweeping) sweeping = doSweep().finally(() => (sweeping = null));
  return sweeping;
}

async function doSweep(now = Date.now()) {
  const dir = env.pbx.spoolDir;
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".evt"));
  } catch {
    return;
  }
  const age = (f) => {
    try {
      return now - fs.statSync(path.join(dir, f)).mtimeMs;
    } catch {
      return -1;
    }
  };
  const ringsOf = (id) => files.filter((f) => f.startsWith(`${id}.ring-`));
  const rotation = await rotationPicker();

  for (const file of files.filter((f) => f.endsWith(".call.evt"))) {
    const id = callIdOf(file);
    if (!safeId(id) || age(file) < SETTLE_MS) continue;
    const rings = ringsOf(id);
    try {
      await processCall(id, rings, rotation);
      for (const f of [file, ...rings]) removeQuietly(path.join(dir, f));
    } catch (err) {
      // The database or ffmpeg failing: the files stay and are tried again.
      console.error(`[pbx] call ${id} not taken in yet: ${err.message}`);
    }
  }

  // Rings without a call: staff calling each other (not kept as calls), or
  // a call file that never came. They still tell whether the phone works.
  const callIds = new Set(files.filter((f) => f.endsWith(".call.evt")).map(callIdOf));
  for (const file of files.filter((f) => f.includes(".ring-"))) {
    const id = file.slice(0, file.indexOf(".ring-"));
    let ring;
    try {
      ring = readEvt(file);
    } catch {
      continue;
    }
    const internal = ring.kind === "internal";
    if (callIds.has(id) && !internal) continue;
    if (age(file) < (internal ? SETTLE_MS : ORPHAN_RING_MS)) continue;
    try {
      if (ring.ext && ring.status) await presence.noteRing(ring.ext, ring.status);
      removeQuietly(path.join(dir, file));
    } catch (err) {
      console.error(`[pbx] ring ${file}: ${err.message}`);
    }
  }
}

function start() {
  const dir = env.pbx.spoolDir;
  let timer = null;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => sweep().catch((err) => console.error("[pbx] sweep failed:", err.message)), SETTLE_MS + 500);
  };
  try {
    fs.watch(dir, soon);
  } catch (err) {
    console.warn(`[pbx] can't watch ${dir}: ${err.message} (checking every 15 s instead)`);
  }
  setInterval(soon, 15 * 1000).unref();
  soon();
}

module.exports = { parseEvt, storedNumber, summarizeCall, missedBy, ringNotices, processCall, sweep, start };
