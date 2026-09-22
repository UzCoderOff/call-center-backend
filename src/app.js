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

const app = express();

// The portal frontend runs on its own domain (Vercel/Netlify) and talks to
// this API with credentials (the httpOnly session cookie), so we need an
// explicit allow-listed origin — "*" is rejected by browsers whenever a
// request carries credentials, and reflecting an arbitrary origin back
// would let any site ride a logged-in user's cookie. CORS_ORIGIN can be a
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
      return callback(new Error("not_allowed_by_cors"));
    },
    credentials: true,
  })
);
app.use(cookieParser());
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

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

app.use((req, res) => res.status(404).json({ error: "not_found" }));
app.use(errorHandler);

module.exports = app;
