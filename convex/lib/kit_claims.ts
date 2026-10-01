export type KitEvidence = { names: string[]; contents: string[] };
const categories = [
  ["charger", /\bchargers?\b/i], ["battery", /\bbatter(?:y|ies)\b/i], ["card", /\b(?:cards?|sd|cfast|cfexpress)\b/i],
  ["cage", /\bcages?\b/i], ["tripod", /\btripods?\b/i], ["microphone", /\b(?:mics?|microphones?)\b/i],
  ["case", /\b(?:cases?|bags?)\b/i], ["filter", /\bfilters?\b/i], ["monitor", /\bmonitors?\b/i],
  ["gimbal", /\bgimbals?\b/i], ["adapter", /\badapters?\b/i], ["ssd", /\bssd\b/i],
] as const;
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Negative/optional offers are not claims of included contents. Preserve item attribution. */
export function unsupportedKitClaims(text: string, evidence: KitEvidence[]) {
  const failures: { sentence: string; content: string }[] = [];
  let subject: KitEvidence[] = [];
  let includedList = false;
  for (const sentence of text.split(/(?<=[.!?])\s+|\n/)) {
    if (!sentence.trim()) continue;
    const normalized = normalize(sentence);
    const named = evidence.filter(e => e.names.some(name => name && normalized.includes(normalize(name))));
    if (named.length) subject = named;
    const match = /\b(?:comes with|ships with|bundled with|includes?|included)\b/i.exec(sentence);
    const bullet = includedList && /^\s*(?:[-•*]\s+|\d+\s*[x×]\s+)/i.test(sentence);
    if (!match && !bullet) { includedList = false; continue; }
    if (/\b(?:does not|doesn't|not|without)\s+(?:come|ship|include)/i.test(sentence)) { includedList = false; continue; }
    if (match) includedList = /:\s*$/.test(sentence);
    let claimed = match ? sentence.slice(match.index + match[0].length) : sentence;
    if (match?.[0].toLowerCase() === "included") claimed = sentence;
    claimed = claimed.split(/\b(?:but not|except|excluding|without)\b/i)[0];
    const candidates = named.length ? named : subject.length ? subject : evidence;
    if (!candidates.length) continue; // unknown-kit guard handles missing evidence separately
    for (const [content, pattern] of categories) {
      if (pattern.test(claimed) && !candidates.every(e => e.contents.some(c => pattern.test(c)))) failures.push({ sentence: sentence.trim(), content });
    }
  }
  return failures;
}
