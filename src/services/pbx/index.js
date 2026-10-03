const env = require("../../config/env");
const state = require("./state");
const { Ami } = require("./ami");
const provision = require("./provision");
const presence = require("./presence");
const ingest = require("./ingest");
const hooks = require("./hooks");

// Ledger's own phone line (pbx/README.md). Runs only where PBX_AMI_SECRET is
// set — the live server; everywhere else (a test computer) nothing changes.
function start() {
  if (!env.pbx.amiSecret) {
    console.log("[pbx] Ledger's phone line: off here (no PBX_AMI_SECRET)");
    return;
  }
  if (!env.pbx.hookSecret) console.warn("[pbx] PBX_HOOK_SECRET is not set: Asterisk can't ask Ledger to wake phones");
  state.enabled = true;
  state.ami = new Ami({ host: env.pbx.amiHost, port: env.pbx.amiPort, user: env.pbx.amiUser, secret: env.pbx.amiSecret }).start();
  // On every (re)connection: the phone IDs and the call-center line as they are now.
  state.ami.on("ready", () => provision.apply().catch((err) => console.error("[pbx] updating the phone line failed:", err.message)));
  hooks.start({
    // Until the Ledger app can be woken by Google push (app 3.0), no phone
    // can be woken: only phones signed in right now ring.
    wake: async () => "0",
  });
  ingest.start();
  setInterval(() => presence.reconcile().catch((err) => console.error("[pbx] call-center line:", err.message)), 60 * 1000).unref();
}

const status = () => ({ enabled: state.enabled, connected: Boolean(state.ami?.ready) });

module.exports = { start, status };
