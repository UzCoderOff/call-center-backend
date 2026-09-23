const env = require("./config/env");
const app = require("./app");
const { describeFfmpegAvailability } = require("./utils/audioTranscode");

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

app.listen(env.port, () => {
  console.log(`call-center-backend listening on port ${env.port} (${env.nodeEnv})`);
});
