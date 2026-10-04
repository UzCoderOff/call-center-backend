const fs = require("fs");
const jwt = require("jsonwebtoken");
const env = require("../../config/env");

// Google push (Firebase Cloud Messaging, HTTP v1) to the Ledger app. The
// server signs in with the Firebase service account (FCM_SERVICE_ACCOUNT_FILE,
// kept out of git, chmod 600) and gets an access token for an hour.
//
// Messages carry ids only — never a client's name, number or a chat's text:
// the app fetches those from Ledger over HTTPS, so nothing private passes
// through Google. They are data-only (the app decides what to show) and high
// priority (a call has to wake a sleeping phone at once).

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

let account = null; // the service account, read once
let cached = null; // { token, until }

function serviceAccount() {
  if (account) return account;
  const file = env.fcm.serviceAccountFile;
  if (!file) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j.type !== "service_account" || !j.private_key || !j.client_email || !j.project_id) throw new Error("not a service account key");
    account = j;
    return account;
  } catch (err) {
    console.error(`[push] can't use ${file}: ${err.message}`);
    return null;
  }
}

const configured = () => Boolean(serviceAccount());

// Pure: the sign-in claims for Google's token endpoint.
function jwtClaims(acc, nowSec) {
  return { iss: acc.client_email, scope: SCOPE, aud: acc.token_uri || "https://oauth2.googleapis.com/token", iat: nowSec, exp: nowSec + 3600 };
}

async function accessToken() {
  if (cached && cached.until > Date.now()) return cached.token;
  const acc = serviceAccount();
  if (!acc) throw new Error("push not configured (FCM_SERVICE_ACCOUNT_FILE)");
  const assertion = jwt.sign(jwtClaims(acc, Math.floor(Date.now() / 1000)), acc.private_key, { algorithm: "RS256" });
  const res = await fetch(acc.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Google sign-in failed: ${body.error_description || body.error || res.status}`);
  // A few minutes early, so a token never expires mid-send.
  cached = { token: body.access_token, until: Date.now() + Math.max(60, (body.expires_in || 3600) - 300) * 1000 };
  return cached.token;
}

// Pure: the message for one phone. data values must be strings.
function buildMessage(fcmToken, data, { ttlSec = 60 } = {}) {
  return {
    message: {
      token: fcmToken,
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: "HIGH", ttl: `${ttlSec}s` },
    },
  };
}

// Pure: what a failed send means. "gone": the app was uninstalled or its
// address changed — forget it; "retry": try again later; "error": ours.
function classifyError(status, body) {
  const code = body?.error?.details?.find?.((d) => d.errorCode)?.errorCode || body?.error?.status || "";
  if (status === 404 || code === "UNREGISTERED") return "gone";
  if (status === 400 && /registration token|INVALID_ARGUMENT/i.test(`${code} ${body?.error?.message || ""}`)) return "gone";
  if (status === 429 || status >= 500) return "retry";
  return "error";
}

// Sends; returns "sent" | "gone" | "retry" | "error". Never throws.
async function send(fcmToken, data, options) {
  try {
    const acc = serviceAccount();
    if (!acc || !fcmToken) return "error";
    const res = await fetch(env.fcm.apiUrl || `https://fcm.googleapis.com/v1/projects/${acc.project_id}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildMessage(fcmToken, data, options)),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return "sent";
    const body = await res.json().catch(() => ({}));
    const kind = classifyError(res.status, body);
    if (kind !== "gone") console.warn(`[push] send failed (${res.status}): ${body?.error?.message || ""}`);
    return kind;
  } catch (err) {
    console.warn(`[push] send failed: ${err.message}`);
    return "retry";
  }
}

// Gets the Google sign-in ready at startup, so the first call doesn't wait.
function warmUp() {
  if (!configured()) return;
  accessToken().then(
    () => console.log("[push] Google push ready"),
    (err) => console.error(`[push] ${err.message}`)
  );
}

module.exports = { configured, jwtClaims, buildMessage, classifyError, send, warmUp };
