const env = require("./config/env");
const app = require("./app");
const { describeFfmpegAvailability } = require("./utils/audioTranscode");
const { prepareDatabase } = require("./lib/dbSetup");
const { listenAll } = require("./lib/listen");
const telegram = require("./services/telegram");
const prisma = require("./lib/prisma");
const { linkAllConsultationFees } = require("./services/consultationFee");
const scheduler = require("./services/scheduler");

// Check this once, loudly, at startup — so a missing/broken ffmpeg (e.g.
// ffmpeg-static's binary never downloaded because this server has no
// outbound internet access) shows up in the deploy logs immediately,
// instead of only being discovered the first time someone in the field
// tries to play back an AMR recording.
const ffmpegStatus = describeFfmpegAvailability();
console[ffmpegStatus.ok ? "log" : "warn"](ffmpegStatus.message);

// Without these, an uncaught error anywhere off the request path (a bad
// await, a rejected promise nobody attached a .catch to) kills the process
// silently under a process manager like pm2/systemd, which just restarts
// it — leaving no trace of what happened, only a gap in "why did sync stop
// working for a while."
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});

// SQLite in WAL mode: reading never waits for someone saving, and saves
// queue briefly instead of failing — what several operators working at once
// need. The setting is stored in the database file, so this is idempotent.
prepareDatabase()
  .catch((err) => console.error("database setup:", err.message))
  .finally(() => {
    // On the server only this machine's own addresses (HOST, config/env.js):
    // Caddy is the way in from outside.
    listenAll(app, env.port, env.hosts).then(started, (err) => {
      // e.g. the port is taken by another copy: stop, so pm2 shows the real
      // problem instead of a server that says it listens but doesn't.
      console.error(`could not listen on ${err.where || `port ${env.port}`}:`, err.message);
      process.exit(1);
    });
  });

// Once every address is up (and only once).
function started(listeners) {
  for (const { where } of listeners) console.log(`call-center-backend listening on ${where} (${env.nodeEnv})`);
  // Consultation fees recorded on a client's page before they were tied
  // to appointments: tie them now (harmless to repeat).
  linkAllConsultationFees(prisma)
    .then((n) => n > 0 && console.log(`consultation fees tied to appointments: ${n}`))
    .catch((err) => console.error("tying consultation fees:", err.message));
  // The staff Telegram bot (off without TELEGRAM_BOT_TOKEN).
  telegram.start();
  // Late call-back strikes and other work on a clock.
  scheduler.start();
  // Ledger's own phone line (off without PBX_AMI_SECRET).
  require("./services/pbx").start();
}
