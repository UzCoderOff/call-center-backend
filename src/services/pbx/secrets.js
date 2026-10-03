const crypto = require("crypto");
const env = require("../../config/env");

// A phone's sign-in to Ledger's phone line. Asterisk checks digest sign-ins
// against md5("<ext>:<realm>:<secret>") (its md5_cred), so that hash is all
// that's kept — and in the database only encrypted with PBX_SECRET_KEY, so a
// copy of the database (the off-site backup) can't sign a phone in. The
// secret itself is shown once and never stored.

const newSecret = () => crypto.randomBytes(24).toString("base64url");

const ha1 = (user, realm, secret) => crypto.createHash("md5").update(`${user}:${realm}:${secret}`).digest("hex");

function keyFrom(hex = env.pbx.secretKey) {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("PBX_SECRET_KEY must be 64 hex characters (openssl rand -hex 32)");
  return Buffer.from(hex, "hex");
}

const hasKey = () => {
  try {
    keyFrom();
    return true;
  } catch {
    return false;
  }
};

// AES-256-GCM: "iv.tag.ciphertext", base64url each.
function seal(text, key = keyFrom()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

function open(sealed, key = keyFrom()) {
  const [iv, tag, data] = String(sealed).split(".").map((s) => Buffer.from(s, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

module.exports = { newSecret, ha1, seal, open, hasKey, keyFrom };
