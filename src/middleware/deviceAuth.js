const crypto = require("crypto");
const prisma = require("../lib/prisma");

// Authentication for the Android app: `Authorization: Bearer <device token>`.
// The token is issued once at sign-in (routes/device.js) and only its hash
// is stored, so a database leak doesn't leak working tokens.

function generateDeviceToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashDeviceToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function bearerToken(req) {
  const header = req.get("authorization") || "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

// Resolves the device + its (active) user, or null.
async function findDevice(token) {
  if (!token) return null;
  const device = await prisma.device.findUnique({
    where: { tokenHash: hashDeviceToken(token) },
    include: { user: { include: { employee: true } } },
  });
  if (!device || device.revokedAt || !device.user.active) return null;

  if (Date.now() - device.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  }
  return device;
}

async function requireDevice(req, res, next) {
  try {
    const device = await findDevice(bearerToken(req));
    if (!device) return res.status(401).json({ error: "device_not_signed_in" });
    req.device = device;
    req.user = device.user;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { generateDeviceToken, hashDeviceToken, bearerToken, findDevice, requireDevice };
