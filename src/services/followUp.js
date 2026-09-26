const prisma = require("../lib/prisma");

// Missed-call follow-up: for every missed call, work out whether anyone at
// the firm got back to that caller — so "23% of calls missed" can be read
// next to "…and 90% of those were called back within the hour."
//
// A missed call is resolved by the FIRST later call with the same phone
// key (from any employee's phone — whoever called back counts) that
// actually connected:
//   - an outgoing call with duration > 0  -> "called_back"
//   - an answered incoming call           -> "client_called_again"
// If only unanswered outgoing attempts followed it -> "attempted".
// If nothing followed it                           -> "pending".
// A later missed call from the same number doesn't resolve anything.
//
// Only calls within FOLLOW_UP_WINDOW_MS count, so a call months later
// isn't mistaken for a callback.
//
// "handled" is the one manual status (set from the portal when someone
// reached the caller another way). It survives recomputation, except that a
// real connected callback replaces it, since that's more precise.
const FOLLOW_UP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const REACHED_STATUSES = ["called_back", "client_called_again", "handled"];
const NEEDS_CALLBACK_STATUSES = ["pending", "attempted"];

function isConnected(call) {
  return !call.missed && call.durationSeconds > 0;
}

// Pure function: given every call that shares one phone key, returns
// Map<missedCallId, { followUp, followUpCallId, followUpDelaySec }>.
// `callTimestampMs` may be a BigInt or a number.
function computeFollowUps(calls) {
  const sorted = calls
    .map((c) => ({ ...c, ts: Number(c.callTimestampMs) }))
    .sort((a, b) => a.ts - b.ts || a.id - b.id);

  const results = new Map();

  sorted.forEach((missedCall, i) => {
    if (!missedCall.missed) return;

    let resolution = null;
    let firstAttempt = null;

    for (let j = i + 1; j < sorted.length; j++) {
      const later = sorted[j];
      if (later.ts - missedCall.ts > FOLLOW_UP_WINDOW_MS) break;
      if (later.missed) continue;

      if (isConnected(later)) {
        resolution = {
          status: later.callType === "outgoing" ? "called_back" : "client_called_again",
          call: later,
        };
        break;
      }
      if (later.callType === "outgoing" && !firstAttempt) firstAttempt = later;
    }

    let result;
    if (resolution) {
      result = {
        followUp: resolution.status,
        followUpCallId: resolution.call.id,
        followUpDelaySec: Math.round((resolution.call.ts - missedCall.ts) / 1000),
      };
    } else if (missedCall.followUp === "handled") {
      result = { followUp: "handled", followUpCallId: null, followUpDelaySec: null };
    } else if (firstAttempt) {
      result = {
        followUp: "attempted",
        followUpCallId: firstAttempt.id,
        followUpDelaySec: Math.round((firstAttempt.ts - missedCall.ts) / 1000),
      };
    } else {
      result = { followUp: "pending", followUpCallId: null, followUpDelaySec: null };
    }

    results.set(missedCall.id, result);
  });

  return results;
}

const RECONCILE_SELECT = {
  id: true,
  phoneKey: true,
  callType: true,
  missed: true,
  callTimestampMs: true,
  durationSeconds: true,
  followUp: true,
  followUpCallId: true,
  followUpDelaySec: true,
};

// Recomputes follow-up status for every missed call sharing any of these
// phone keys, and writes back only what changed. Idempotent — safe to run
// after every sync, and from scripts/rebuild-follow-ups.js over everything.
async function reconcileFollowUps(phoneKeys) {
  const keys = [...new Set(phoneKeys.filter(Boolean))];
  let changed = 0;

  // Chunked so a full rebuild doesn't produce one enormous IN (...) clause.
  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200);
    const calls = await prisma.callLog.findMany({
      where: { phoneKey: { in: chunk } },
      select: RECONCILE_SELECT,
    });

    const byKey = new Map();
    for (const call of calls) {
      if (!byKey.has(call.phoneKey)) byKey.set(call.phoneKey, []);
      byKey.get(call.phoneKey).push(call);
    }

    const updates = [];
    for (const group of byKey.values()) {
      const computed = computeFollowUps(group);
      for (const call of group) {
        const next = computed.get(call.id);
        if (!next) continue;
        if (
          next.followUp !== call.followUp ||
          next.followUpCallId !== call.followUpCallId ||
          next.followUpDelaySec !== call.followUpDelaySec
        ) {
          updates.push(prisma.callLog.update({ where: { id: call.id }, data: next }));
        }
      }
    }

    if (updates.length > 0) {
      await prisma.$transaction(updates);
      changed += updates.length;
    }
  }

  return changed;
}

module.exports = {
  FOLLOW_UP_WINDOW_MS,
  REACHED_STATUSES,
  NEEDS_CALLBACK_STATUSES,
  computeFollowUps,
  reconcileFollowUps,
};
