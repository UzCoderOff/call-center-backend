const { getSetting, setSetting } = require("../../lib/settings");

// Firm-wide settings of Ledger's phone line (Setting "pbx"), with defaults.
//   companyNumber  the firm's number on the outside line, e.g. "+998781130000"
//   trunkEnabled   the outside line (SkyLine) is connected: calls out are allowed
//   rotation       whose turn it is to own a missed call nobody was rung for
//   night          outside working hours (the user's ask, 2026-10-26): from
//                  `from` to `to` in the firm's time nobody is rung — the
//                  caller hears the night message and leaves their own
//                  (extensions.conf [line-message])
//   testNumbers    the firm's own phones ("+998…") for trying the voice
//                  messages: a call from one rings nobody and isn't kept
//                  (extensions.conf [line-preview])
const NIGHT_DEFAULTS = { on: false, from: "22:00", to: "08:00" };
const PBX_DEFAULTS = { companyNumber: "", trunkEnabled: false, rotation: 0, night: NIGHT_DEFAULTS, testNumbers: [] };

const pbxSettings = async (db) => {
  const settings = await getSetting("pbx", PBX_DEFAULTS, db);
  return { ...settings, night: { ...NIGHT_DEFAULTS, ...settings.night } };
};

async function savePbxSettings(patch, userId, db) {
  const current = await pbxSettings(db);
  return setSetting("pbx", { ...current, ...patch }, userId, db);
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

// The night hours as Asterisk's GotoIfTime wants them: both ends included,
// so "22:00"–"08:00" is "22:00-07:59" (08:00 is working time again). A range
// past midnight is fine. "" when it's off or makes no sense.
function nightRange(night) {
  if (!night?.on || !HHMM.test(night.from || "") || !HHMM.test(night.to || "") || night.from === night.to) return "";
  return `${night.from}-${hhmm((minutesOf(night.to) + 24 * 60 - 1) % (24 * 60))}`;
}

module.exports = { PBX_DEFAULTS, NIGHT_DEFAULTS, HHMM, pbxSettings, savePbxSettings, nightRange };
