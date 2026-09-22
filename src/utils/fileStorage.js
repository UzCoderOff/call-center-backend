const fs = require("fs");
const path = require("path");
const env = require("../config/env");

fs.mkdirSync(env.storageRoot, { recursive: true });

// Recording filenames come from the device's own filesystem (whatever the
// dialer/recorder app named them) and must never be trusted as a path —
// only the extension is kept, everything else about the on-disk name is
// generated here. Files are grouped per employee so a directory listing is
// still human-browsable if someone ever needs to look directly on disk.
function safeExtension(originalFilename) {
  const ext = path.extname(originalFilename || "").toLowerCase();
  // Guard against something like "../../evil.sh" being used as the
  // "extension" — only allow short, plain alphanumeric extensions.
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : "";
}

function saveRecording({ employeeId, deviceCallLogId, originalFilename, buffer }) {
  const dir = path.join(env.storageRoot, employeeId);
  fs.mkdirSync(dir, { recursive: true });

  const ext = safeExtension(originalFilename);
  const filename = `${deviceCallLogId}${ext}`;
  const absolutePath = path.join(dir, filename);
  fs.writeFileSync(absolutePath, buffer);

  // Stored relative to STORAGE_ROOT so the DB stays portable if the server
  // is ever moved to a different disk path.
  return path.join(employeeId, filename);
}

function resolveRecordingPath(relativePath) {
  return path.join(env.storageRoot, relativePath);
}

module.exports = { saveRecording, resolveRecordingPath };
