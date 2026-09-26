const path = require("path");
require("dotenv").config();

// Fail loudly and immediately if something required is missing, rather than
// limping along and producing a confusing error later (e.g. a JWT signed
// with "undefined" as the secret).
const REQUIRED = ["DATABASE_URL", "JWT_SECRET"];
const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(", ")}. ` +
      "Copy .env.example to .env and fill them in."
  );
}

const storageRoot = path.isAbsolute(process.env.STORAGE_ROOT || "")
  ? process.env.STORAGE_ROOT
  : path.join(process.cwd(), process.env.STORAGE_ROOT || "./storage/recordings");

const downloadsDir = process.env.DOWNLOADS_DIR
  ? path.resolve(process.env.DOWNLOADS_DIR)
  : path.join(path.dirname(storageRoot), "downloads");

module.exports = {
  port: Number(process.env.PORT) || 4000,
  downloadsDir,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "12h",
  storageRoot,
  cookieSecure: process.env.COOKIE_SECURE === "true",
  // "lax" only sends the cookie on same-site requests, which silently
  // breaks login once the frontend is on its own domain. "none" is
  // required for cross-site requests but browsers only honor it when the
  // cookie is also Secure, i.e. served over HTTPS — see COOKIE_SECURE.
  cookieSameSite: process.env.COOKIE_SAME_SITE || "lax",
  corsOrigin: process.env.CORS_ORIGIN || "",
  nodeEnv: process.env.NODE_ENV || "development",
  adminUsername: process.env.ADMIN_USERNAME,
  adminPassword: process.env.ADMIN_PASSWORD,
  // Which calendar day a daily report belongs to is decided in the firm's
  // own timezone, not the server's (a VPS usually runs on UTC).
  firmTimezone: process.env.FIRM_TIMEZONE || "Asia/Tashkent",
  // The newest Android app build, so installed apps can offer an update.
  // Leave APP_LATEST_VERSION_CODE unset to disable the prompt.
  appLatest: {
    versionCode: Number(process.env.APP_LATEST_VERSION_CODE) || null,
    versionName: process.env.APP_LATEST_VERSION_NAME || null,
    downloadUrl: process.env.APP_DOWNLOAD_URL || null,
  },
};
