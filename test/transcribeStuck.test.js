const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const prisma = require("../src/lib/prisma");
const env = require("../src/config/env");
const transcribe = require("../src/services/pbx/transcribe");

// next() and failed() with a stand-in transcript table: a call the transcriber
// gets stuck on is tried once more, then given up on — not put back in the
// queue every hour for ever (2026-10-28: one 14-second call froze the server
// again and again).
const HOURS_AGO = (h) => new Date(Date.now() - h * 60 * 60 * 1000);

function table(rows) {
  const matches = (row, where) =>
    Object.entries(where).every(([key, want]) => {
      if (want && typeof want === "object" && "lt" in want) return row[key] < want.lt;
      if (want && typeof want === "object" && "startsWith" in want) return typeof row[key] === "string" && row[key].startsWith(want.startsWith);
      return row[key] === want;
    });
  prisma.transcript.updateMany = async ({ where, data }) => {
    const hit = rows.filter((r) => matches(r, where));
    for (const r of hit) Object.assign(r, data, { updatedAt: new Date() });
    return { count: hit.length };
  };
  prisma.transcript.findFirst = async ({ where }) => rows.filter((r) => matches(r, where)).sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  prisma.transcript.findUnique = async ({ where }) => rows.find((r) => r.callLogId === where.callLogId) || null;
  prisma.transcript.update = async ({ where, data }) => Object.assign(rows.find((r) => r.callLogId === where.callLogId), data, { updatedAt: new Date() });
  return rows;
}

// The queued side files next() hands out.
function queued(...ids) {
  env.storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-transcribe-"));
  fs.mkdirSync(transcribe.DIR());
  for (const id of ids) fs.writeFileSync(path.join(transcribe.DIR(), `${id}.client.wav`), "");
}

test("a call stuck 'processing' goes back in the queue once, and is given up on the second time", async () => {
  queued(5);
  const [row] = table([{ callLogId: 5, status: "processing", errorMessage: null, createdAt: HOURS_AGO(3), updatedAt: HOURS_AGO(2) }]);

  const job = await transcribe.next();
  assert.equal(job.id, 5);
  assert.equal(row.status, "processing");
  assert.match(row.errorMessage, /^stuck once, trying again: the transcriber never answered/);

  // Stuck again: the transcriber died on it a second time.
  row.updatedAt = HOURS_AGO(2);
  assert.deepEqual(await transcribe.next(), {});
  assert.equal(row.status, "failed");
  assert.equal(row.errorMessage, "stuck twice, given up: the transcriber never answered");
});

test("a call that took the transcriber past its time or memory limit gets one more try, then fails", async () => {
  queued(7);
  const [row] = table([{ callLogId: 7, status: "processing", errorMessage: null, createdAt: HOURS_AGO(1), updatedAt: new Date() }]);

  await transcribe.failed({ id: 7, error: "transcriber stopped: not done in 102s (limit for this call)", stuck: true });
  assert.equal(row.status, "pending");
  assert.match(row.errorMessage, /^stuck once, trying again: transcriber stopped: not done in 102s/);

  assert.equal((await transcribe.next()).id, 7);
  await transcribe.failed({ id: 7, error: "transcriber stopped: used 1600 MB (limit 1500 MB)", stuck: true });
  assert.equal(row.status, "failed");
  assert.equal(row.errorMessage, "stuck twice, given up: transcriber stopped: used 1600 MB (limit 1500 MB)");
});

test("stuck once by its limits, then never answered: given up; work still going on and ordinary failures are left as they were", async () => {
  queued(8, 9);
  const rows = table([
    { callLogId: 8, status: "processing", errorMessage: null, createdAt: HOURS_AGO(2), updatedAt: new Date() },
    { callLogId: 9, status: "processing", errorMessage: null, createdAt: HOURS_AGO(1), updatedAt: HOURS_AGO(0.5) },
  ]);
  const [eight, nine] = rows;

  await transcribe.failed({ id: 8, error: "transcriber stopped: not done in 90s", stuck: true });
  assert.equal((await transcribe.next()).id, 8);
  eight.updatedAt = HOURS_AGO(2);
  assert.deepEqual(await transcribe.next(), {});
  assert.equal(eight.status, "failed");
  assert.match(eight.errorMessage, /^stuck twice, given up/);
  // Half an hour in: still being worked on.
  assert.equal(nine.status, "processing");
  assert.equal(nine.errorMessage, null);

  await transcribe.failed({ id: 9, error: "ffmpeg: invalid data" });
  assert.equal(nine.status, "failed");
  assert.equal(nine.errorMessage, "ffmpeg: invalid data");
});
