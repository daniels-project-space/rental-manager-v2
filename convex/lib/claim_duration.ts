const small = ["zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
const tens = ["twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];
const count = `(?:\\d+|${small.join("|")}|(?:${tens.join("|")})(?:[ -](?:${small.slice(1,10).join("|")}))?)`;
const qualification = `(?:(?:the|these|those|your|a|an)\\s+)?${count}[ -]+days?(?:\\s+(?:hire|rental|booking))?`;

/** A duration qualifies a price's scope, never its item identity. Keep the
 * original text for validation even when removing it from an anaphor. */
export function withoutDurationReference(reference: string) {
  return reference.replace(new RegExp(`\\s+for\\s+${qualification}\\s*$`,"i"), "")
    .replace(/\s+for\s+(?:(?:these|those|the requested)\s+dates|this\s+(?:hire|rental|booking))\s*$/i, "");
}
export function claimedRentalDays(text: string): number | null {
  const match = new RegExp(`\\b(?:for|across|over|total\\s+for)\\s+(?:(?:the|these|those|your|a|an)\\s+)?(${count})[ -]+days?\\b`,"i").exec(text);
  if (!match) return /\b(?:for|across|over|total\s+for)\s+(?:(?:[a-z]+|\d+)[ -]+){1,5}days?\b/i.test(text)
    || /\b(?:for|across|over)\s+(?:the\s+)?\d+\s*(?:[-–]|to|or)\s*\d+\s*days?\b/i.test(text) ? NaN : null;
  if (/^\d+$/.test(match[1])) return Number(match[1]);
  const words = match[1].toLowerCase().split(/[ -]+/);
  const first = small.indexOf(words[0]);
  return first >= 0 ? first : (tens.indexOf(words[0])+2)*10+(words[1] ? small.indexOf(words[1]) : 0);
}
