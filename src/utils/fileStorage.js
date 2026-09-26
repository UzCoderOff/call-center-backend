const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const env = require("../config/env");

fs.mkdirSync(env.storageRoot, { recursive: true });

// Uploads land here first (see routes/sync.js) and are only moved into
// STORAGE_ROOT once the sync request is authenticated and matched to a
// call. Anything still in here at startup is a leftover from a crash
// mid-upload, so it's cleared.
const INCOMING_DIR = path.join(path.dirname(env.storageRoot), "incoming");
fs.rmSync(INCOMING_DIR, { recursive: true, force: true });
fs.mkdirSync(INCOMING_DIR, { recursive: true });

function incomingFilename() {
  return `${Date.now()}-${crypto.randomBytes(8).toString("hex")}.part`;
}

// Recording filenames come from the device's own filesystem (whatever the
// dialer/recorder app named them) and must never be trusted as a path —
// only the extension is kept, everything else about the on-disk name is
// generated here.
function safeExtension(originalFilename) {
  const ext = path.extname(originalFilename || "").toLowerCase();
  // Guard against something like "../../evil.sh" being used as the
  // "extension" — only allow short, plain alphanumeric extensions.
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : "";
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    // STORAGE_ROOT on a different disk than the incoming folder.
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

// Files are grouped per employee (by database id, which never changes —
// unlike the device token, which gets rotated) and named after the call's
// own timestamp + device call-log id, which together are unique even across
// a phone replacement.
function saveRecording({ employeeDbId, deviceCallLogId, callTimestampMs, originalFilename, tempPath }) {
  const dirName = String(employeeDbId);
  fs.mkdirSync(path.join(env.storageRoot, dirName), { recursive: true });

  const safeCallLogId = String(deviceCallLogId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${callTimestampMs}-${safeCallLogId}${safeExtension(originalFilename)}`;
  moveFile(tempPath, path.join(env.storageRoot, dirName, filename));

  // Stored relative to STORAGE_ROOT so the DB stays portable if the server
  // is ever moved to a different disk path.
  return path.join(dirName, filename);
}

function resolveRecordingPath(relativePath) {
  return path.join(env.storageRoot, relativePath);
}

function removeQuietly(filePath) {
  if (!filePath) return;
  fs.rm(filePath, { force: true }, () => {});
}

module.exports = { INCOMING_DIR, incomingFilename, saveRecording, resolveRecordingPath, removeQuietly };
