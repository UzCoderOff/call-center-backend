const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const errorHandler = require("./middleware/errorHandler");
const env = require("./config/env");

const authRoutes = require("./routes/auth");
const syncRoutes = require("./routes/sync");
const employeeRoutes = require("./routes/employees");
const callRoutes = require("./routes/calls");
const dashboardRoutes = require("./routes/dashboard");
const userRoutes = require("./routes/users");
const syncLogRoutes = require("./routes/syncLogs");
const deviceRoutes = require("./routes/device");
const reportRoutes = require("./routes/reports");
const organization = require("./routes/organization");
const calendarRoutes = require("./routes/calendar");
const clientRoutes = require("./routes/clients");
const caseWork = require("./routes/caseWork");
const clientWork = require("./routes/clientWork");
const materialRoutes = require("./routes/materials");
const telegramRoutes = require("./routes/telegram");
const financeRoutes = require("./routes/finance");
const taskRoutes = require("./routes/tasks");
const performanceRoutes = require("./routes/performance");
const daysOffRoutes = require("./routes/daysOff");
const cashRoutes = require("./routes/cash");

const app = express();

// Prisma returns BigInt for the millisecond-timestamp columns, and
// JSON.stringify throws on BigInt. Every res.json() converts them here, at
// any nesting depth, instead of each route remembering to. Millisecond epoch
// timestamps are far below Number.MAX_SAFE_INTEGER, so nothing is lost.
app.set("json replacer", (key, value) => (typeof value === "bigint" ? Number(value) : value));

// The portal is served from its own domain (Vercel) and reaches this API
// through that domain's /api proxy (see vercel.json in the portal repo), so
// the browser only ever talks to one site and the session cookie is a
// first-party cookie. (Calling this API cross-site directly made it a
// third-party cookie, which phone browsers silently drop.)
//
// CORS stays as a guard: requests carrying an Origin header must come from
// an allow-listed origin. The proxy forwards the browser's Origin, so
// CORS_ORIGIN must list the portal's URL. CORS_ORIGIN can be a
// comma-separated list to support e.g. a preview + a production URL.
const allowedOrigins = (env.corsOrigin || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header (curl, server-to-server, the Android sync client)
      // -> not a browser CORS request, nothing to check.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      const err = new Error("origin_not_allowed");
      err.status = 403;
      return callback(err);
    },
    credentials: true,
  })
);
app.use(cookieParser());
// Spreadsheet imports arrive in batches of up to 200 rows — more than the
// default 100 KB. Everything else keeps the small default.
app.use("/api/clients/import", express.json({ limit: "2mb" }));
app.use(express.json());

// Lightweight request logger — method, path, status, duration. Not a
// replacement for real observability, but enough to see e.g. a spike of
// 413s from one device in plain server logs without adding a dependency.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

app.get("/health", (req, res) => res.json({ ok: true }));

// The Android app's APK, for installing and for the in-app "new version"
// prompt (APP_DOWNLOAD_URL). Copy each release build here as ledger.apk.
// The APK holds no secrets — it only works with a valid account.
app.use("/downloads", express.static(env.downloadsDir, { index: false, fallthrough: true }));

// Device-facing: the Android app posts here directly, authenticated by the
// employeeId embedded in its payload rather than a portal session cookie.
app.use("/api/calls", syncRoutes);

// Portal-facing: everything below requires a logged-in session (enforced
// inside each router).
app.use("/api/auth", authRoutes);
app.use("/api/employees", employeeRoutes);
app.use("/api/calls", callRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/users", userRoutes);
app.use("/api/sync-logs", syncLogRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/offices", organization.offices);
app.use("/api/positions", organization.positions);
app.use("/api/report-templates", organization.templates);
app.use("/api/calendars", calendarRoutes.calendars);
app.use("/api/appointments", calendarRoutes.appointments);
app.use("/api/clients", clientRoutes.clients);
app.use("/api/client-cases", clientRoutes.cases);
app.use("/api/client-cases", caseWork.caseItems);
app.use("/api/client-stages", caseWork.stages);
app.use("/api/client-dates", caseWork.dates);
// Connected people, follow-ups and files (some hang off /api/clients/:id).
clientWork.attach(clientRoutes.clients);
app.use("/api/client-contacts", clientWork.contacts);
app.use("/api/client-follow-ups", clientWork.followUps);
app.use("/api/client-files", clientWork.files);
// The call center's rules (late call-back strikes, who counts as the call
// center) and the strikes given.
const ruleRoutes = require("./routes/rules");
app.use("/api/rules", ruleRoutes.rules);
app.use("/api/strikes", ruleRoutes.strikes);
app.use("/api/client-payments", clientRoutes.payments);
app.use("/api/client-notes", clientRoutes.notes);
app.use("/api/client-links", clientRoutes.links);
app.use("/api/audit", clientRoutes.auditLog);
app.use("/api/materials", materialRoutes);
app.use("/api/telegram", telegramRoutes);
app.use("/api/finance", financeRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/performance", performanceRoutes);
app.use("/api/holidays", daysOffRoutes.holidays);
app.use("/api/absences", daysOffRoutes.absences);
app.use("/api/cash", cashRoutes);

// Android app: sign-in with a portal account, device-token session refresh,
// "collect calls?" config. Authenticated by device token, not the cookie.
app.use("/api/device", deviceRoutes);

app.use((req, res) => res.status(404).json({ error: "not_found" }));
app.use(errorHandler);

module.exports = app;
