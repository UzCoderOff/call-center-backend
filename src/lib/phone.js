// The same caller shows up in different shapes depending on which phone,
// dialer, or direction logged the call: "+998 90 123 45 67",
// "998901234567", "901234567", "8 90 123 45 67". To tell that a callback
// went to the person who called, every number is reduced to a "phone key".
//
// Uzbek numbers have a 9-digit national part (2-digit operator code + 7
// digits), so the key is the last 9 digits. That also works for most
// foreign numbers in practice — two different people sharing the same last
// 9 digits is not a realistic collision for one firm's call volume.
//
// Hidden/private numbers come through Android's call log as "", "-1",
// "-2" or similar. Those (and anything too short to be a real number) get
// a null key: they can't be matched to a callback, and can't be called
// back at all.
const KEY_LENGTH = 9;
const MIN_DIGITS = 5;

function phoneKey(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < MIN_DIGITS) return null;
  return digits.length > KEY_LENGTH ? digits.slice(-KEY_LENGTH) : digits;
}

module.exports = { phoneKey };
