// The numbers the company line may call, in the form the trunk wants. Only
// Uzbek numbers go out. Anything abroad, short service numbers and the
// emergency numbers are refused here — the app sends emergency numbers to
// the phone's own dialer instead.
const EMERGENCY = new Set(["101", "102", "103", "104", "112"]);

// raw -> { national: "901234567", e164: "+998901234567" }
//      | { blocked: "emergency" | "international" | "short" | "invalid" }
function normalizeUz(raw) {
  const text = String(raw ?? "").trim().replace(/[\s()-]/g, "");
  const digits = text.replace(/\D/g, "");
  if (EMERGENCY.has(digits)) return { blocked: "emergency" };
  let national;
  if (/^\+?998\d{9}$/.test(text)) national = digits.slice(3);
  else if (text.startsWith("+") || digits.startsWith("00")) return { blocked: "international" };
  else if (/^\d{9}$/.test(text)) national = digits;
  // The old domestic prefix: "8 90 123 45 67".
  else if (/^8\d{9}$/.test(text)) national = digits.slice(1);
  else if (digits.length > 0 && digits.length < 7) return { blocked: "short" };
  else return { blocked: "invalid" };
  return { national, e164: `+998${national}` };
}

// A staff phone ID ("phone ID"): three digits, 201–899.
const isExtension = (value) => /^[2-8]\d\d$/.test(String(value ?? ""));

module.exports = { EMERGENCY, normalizeUz, isExtension };
