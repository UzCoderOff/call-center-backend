const { getSetting, setSetting } = require("../../lib/settings");

// Firm-wide settings of Ledger's phone line (Setting "pbx"), with defaults.
//   companyNumber  the firm's number on the outside line, e.g. "+998781130000"
//   trunkEnabled   the outside line (SkyLine) is connected: calls out are allowed
//   rotation       whose turn it is to own a missed call nobody was rung for
const PBX_DEFAULTS = { companyNumber: "", trunkEnabled: false, rotation: 0 };

const pbxSettings = (db) => getSetting("pbx", PBX_DEFAULTS, db);

async function savePbxSettings(patch, userId, db) {
  const current = await pbxSettings(db);
  return setSetting("pbx", { ...current, ...patch }, userId, db);
}

module.exports = { PBX_DEFAULTS, pbxSettings, savePbxSettings };
