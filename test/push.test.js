const test = require("node:test");
const assert = require("node:assert/strict");
const { jwtClaims, buildMessage, classifyError } = require("../src/services/push/fcm");

test("Google sign-in claims: our service account, push only, one hour", () => {
  const c = jwtClaims({ client_email: "push@ledger.iam.gserviceaccount.com", token_uri: "https://oauth2.googleapis.com/token" }, 1000);
  assert.deepEqual(c, { iss: "push@ledger.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: 1000, exp: 4600 });
});

test("a push is data-only, high priority, short-lived, all values strings", () => {
  const m = buildMessage("tok", { t: "call", e: 203, x: 123 }, { ttlSec: 15 });
  assert.deepEqual(m, { message: { token: "tok", data: { t: "call", e: "203", x: "123" }, android: { priority: "HIGH", ttl: "15s" } } });
  assert.equal(m.message.notification, undefined);
});

test("a gone push address is forgotten; Google's own trouble is retried", () => {
  assert.equal(classifyError(404, { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }), "gone");
  assert.equal(classifyError(400, { error: { status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token" } }), "gone");
  assert.equal(classifyError(503, {}), "retry");
  assert.equal(classifyError(429, {}), "retry");
  assert.equal(classifyError(403, { error: { status: "PERMISSION_DENIED" } }), "error");
});
