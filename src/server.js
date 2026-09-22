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

app.listen(env.port, () => {
  console.log(`call-center-backend listening on port ${env.port} (${env.nodeEnv})`);
});
