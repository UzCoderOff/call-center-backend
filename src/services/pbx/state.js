// What the phone-line services share while the server runs (set by index.js):
//   enabled  PBX_AMI_SECRET is set: Ledger's phone line is in use here
//   ami      the connection to Asterisk (ami.js), or null
module.exports = { enabled: false, ami: null };
