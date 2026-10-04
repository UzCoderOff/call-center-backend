const webpush = require("web-push");
const prisma = require("../../lib/prisma");
const env = require("../../config/env");

// Notifications in browsers (the portal on a computer or a phone's browser):
// the Web Push standard. The portal asks the browser for a subscription
// (public/sw.js shows what arrives) and sends it here (routes/push.js).
// Each message is encrypted for that one browser — the push service in
// between can't read it — so it carries the text itself, unlike the app's
// Google push (ids only).

const configured = () => Boolean(env.webPush.publicKey && env.webPush.privateKey);

// The "who's sending" contact push services want: the portal's address.
const subject = () => env.portalUrl || "mailto:ledger@localhost";

// { title, body?, link?, tag? } -> each of this person's browsers. Browsers
// that are gone (uninstalled, notifications revoked) are forgotten. Whether
// at least one browser took it.
async function sendToUser(userId, payload) {
  if (!configured()) return false;
  const subs = await prisma.webPushSubscription.findMany({ where: { userId } });
  let sent = false;
  for (const sub of subs) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), {
        vapidDetails: { subject: subject(), publicKey: env.webPush.publicKey, privateKey: env.webPush.privateKey },
        TTL: 24 * 60 * 60,
        urgency: "high",
        timeout: 10000,
      });
      sent = true;
      prisma.webPushSubscription.update({ where: { id: sub.id }, data: { lastOkAt: new Date() } }).catch(() => {});
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await prisma.webPushSubscription.deleteMany({ where: { id: sub.id } });
      } else {
        console.warn(`[push] browser notification failed (${err.statusCode || err.message})`);
      }
    }
  }
  return sent;
}

async function hasBrowser(userId) {
  return configured() && (await prisma.webPushSubscription.count({ where: { userId } })) > 0;
}

module.exports = { configured, sendToUser, hasBrowser };
