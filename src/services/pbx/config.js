// The files Ledger writes for Asterisk (pbx/README.md): pure — data in, file
// text out. The hand-made files in /etc/asterisk include these:
//   pjsip.conf       #include ledger/pjsip_staff.conf   phones that may sign in
//   extensions.conf  #include ledger/extensions_ledger.conf  (busy/free hints)
//                    [globals] #include ledger/globals_ledger.conf
const { isExtension } = require("./numbers");

const HEADER = [
  "; Written by Ledger (src/services/pbx/config.js) - don't edit by hand:",
  "; it is rewritten whenever someone's phone line changes.",
  "",
];

// A person's name as Asterisk's caller ID: no quotes, brackets, semicolons
// (a comment in these files) or line breaks.
function callerName(name) {
  return String(name ?? "").replace(/["<>;\\\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "Ledger";
}

// exts: [{ ext, name, ha1, canCallOut }] — only those whose phone may sign in.
function renderStaff(exts, { realm }) {
  const lines = [...HEADER];
  for (const e of exts) {
    if (!isExtension(e.ext) || !/^[0-9a-f]{32}$/.test(e.ha1 || "")) continue;
    lines.push(
      `[${e.ext}](staff-endpoint)`,
      `auth=${e.ext}`,
      `aors=${e.ext}`,
      // staff-out: colleagues and numbers outside; staff-internal: colleagues only.
      `context=${e.canCallOut ? "staff-out" : "staff-internal"}`,
      `callerid="${callerName(e.name)}" <${e.ext}>`,
      "",
      `[${e.ext}](staff-auth)`,
      `username=${e.ext}`,
      `realm=${realm}`,
      `md5_cred=${e.ha1}`,
      "",
      `[${e.ext}](staff-aor)`,
      ""
    );
  }
  return lines.join("\n");
}

// Whether each phone ID is busy or free: its phone (PJSIP) combined with
// Ledger's own "this phone can be woken up" state (Custom:ledger<ext>), so a
// phone that's asleep but reachable through Google push still counts as
// free, and one in a call counts as busy.
function renderHints(exts) {
  const lines = [...HEADER, "[ledger-hints]"];
  for (const e of exts) if (isExtension(e.ext)) lines.push(`exten => ${e.ext},hint,PJSIP/${e.ext}&Custom:ledger${e.ext}`);
  lines.push("");
  return lines.join("\n");
}

// Values the dialplan reads (inside [globals]).
function renderGlobals(values) {
  const lines = [...HEADER];
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    lines.push(`${key}=${String(value ?? "").replace(/[;\r\n]/g, "")}`);
  }
  lines.push("");
  return lines.join("\n");
}

module.exports = { renderStaff, renderHints, renderGlobals, callerName };
