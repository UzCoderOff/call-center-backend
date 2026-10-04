const prisma = require("../../lib/prisma");
const fcm = require("./fcm");

// Push to Ledger app phones. A phone whose push address Google says is gone
// (app uninstalled, data cleared) is forgotten until the app sends a new one.

async function sendToDevice(device, data, options) {
  if (!device?.fcmToken || device.revokedAt) return "error";
  const result = await fcm.send(device.fcmToken, data, options);
  if (result === "gone") await prisma.device.updateMany({ where: { id: device.id, fcmToken: device.fcmToken }, data: { fcmToken: null } });
  return result;
}

// Wakes a phone for a call coming to it: the app starts, signs in to the
// phone line, and the call rings. Short-lived: a call that has moved on
// shouldn't ring a phone that woke up late.
//   c: the call's id (matched to the ring), e: the phone ID, x: ms until
const sendCallWake = (device, { call, ext }) => sendToDevice(device, { t: "call", c: call || "", e: ext, x: Date.now() + 15000 }, { ttlSec: 15 });

module.exports = { sendToDevice, sendCallWake, configured: fcm.configured, warmUp: fcm.warmUp };
