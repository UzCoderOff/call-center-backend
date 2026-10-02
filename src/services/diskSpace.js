const fs = require("fs");
const env = require("../config/env");

// How full the server's disk is, where recordings are kept. Recordings are
// never deleted by Ledger, so the disk only fills up; the developer hears
// about it (home page, Telegram) well before it's full — a full disk stops
// syncs and the database.
const LOW_FREE_BYTES = 5 * 1024 ** 3; // 5 GB
const LOW_FREE_SHARE = 0.1; // or 10%

async function diskSpace(dir = env.storageRoot) {
  try {
    const s = await fs.promises.statfs(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const share = total > 0 ? free / total : null;
    return { freeBytes: free, totalBytes: total, freeShare: share, low: free < LOW_FREE_BYTES || (share != null && share < LOW_FREE_SHARE) };
  } catch {
    // The folder doesn't exist yet, or the platform can't tell.
    return null;
  }
}

module.exports = { diskSpace, LOW_FREE_BYTES, LOW_FREE_SHARE };
