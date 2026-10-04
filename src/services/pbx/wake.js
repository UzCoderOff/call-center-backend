const prisma = require("../../lib/prisma");
const push = require("../push");

// How long Asterisk waits for a woken phone to sign in to the line, in
// seconds: Google push takes 0.5–2 s, the app starting and signing in about
// 2 more — with room to spare. A phone that doesn't come up in time costs
// the caller this long before the next operator rings.
const WAKE_WAIT_SEC = 8;

// Asterisk asks (hooks.js, [ring-person]): a call for phone ID `ext`, whose
// phone isn't signed in to the line right now. Its Ledger app is woken by
// Google push; the answer is how many seconds to wait for it ("0": it can't
// be woken — no app with push on that phone ID — ring whoever is next).
async function wake({ ext, call }) {
  const row = await prisma.pbxExtension.findUnique({ where: { ext: String(ext || "") }, include: { employee: { select: { active: true, pbxCalling: true } } } });
  if (!row?.employee?.active || !row.employee.pbxCalling || !row.ha1Enc || row.secretDeviceId == null) return "0";
  const device = await prisma.device.findUnique({ where: { id: row.secretDeviceId } });
  if (!device || device.revokedAt || !device.fcmToken) return "0";
  // Not awaited: Asterisk starts waiting at once.
  push.sendCallWake(device, { call, ext: row.ext }).then((result) => {
    if (result !== "sent") console.warn(`[pbx] wake push for ${row.ext}: ${result}`);
  });
  prisma.pbxExtension.update({ where: { id: row.id }, data: { lastWakeAt: new Date() } }).catch(() => {});
  return String(WAKE_WAIT_SEC);
}

module.exports = { wake, WAKE_WAIT_SEC };
