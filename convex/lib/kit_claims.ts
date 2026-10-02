export type KitEvidence = { names: string[]; contents: string[]; booked_camera?: boolean };
const categories = [
  ["charger", /\bchargers?\b/i], ["battery", /\bbatter(?:y|ies)\b/i], ["card", /\b(?:cards?|sd|cfast|cf\s*express)\b/i],
  ["cage", /\bcages?\b/i], ["tripod", /\btripods?\b/i], ["microphone", /\b(?:mics?|microphones?)\b/i],
  ["case", /\b(?:cases?|bags?)\b/i], ["filter", /\bfilters?\b/i], ["monitor", /\bmonitors?\b/i],
  ["gimbal", /\bgimbals?\b/i], ["adapter", /\badapters?\b/i], ["ssd", /\bssd\b/i],
] as const;
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function namesItem(text: string, name: string) {
  const tokens = normalize(name).split(" ").filter(Boolean);
  return tokens.length > 0 && new RegExp(`(?:^| )${tokens.join(" *")}(?: |$)`).test(normalize(text));
}
type ComponentDetails = { types: string[]; capacities: string[]; quantity?: number; quantityUnit?: "sets" | "units" };
const numbers: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const positiveDetail = (text: string, index: number) => !/\b(?:not|no|without|rather than|instead of)\s+(?:(?:an?|the)\s+)?$/i.test(text.slice(0, index));
/** Interpret only explicit component facts. A set is not an individual-unit count. */
function details(text: string, category: string, pattern: RegExp): ComponentDetails {
  const types: string[] = [];
  if (category === "battery") {
    for (const m of text.matchAll(/\b(?:NP[\s-]*(?:FZ100|FW50|F\d+)|LP[\s-]*E\d+[A-Z]*)\b/gi)) {
      if (positiveDetail(text, m.index!)) types.push(normalize(m[0]).replace(/ /g, ""));
    }
  }
  if (category === "card") {
    for (const m of text.matchAll(/\b(?:cf\s*express(?:\s+(?:type\s+)?[ab])?|cfast|micro\s*sd|sd(?:hc|xc)?)\b/gi)) {
      if (positiveDetail(text, m.index!)) types.push(normalize(m[0]).replace(/ /g, "").replace(/^cfexpress([ab])$/, "cfexpresstype$1"));
    }
  }
  if (category === "adapter") {
    for (const m of text.matchAll(/\b(PL|EF(?:-S)?|RF|E|L)\s*(?:-?\s*to\s*-?|[-–—→])\s*(?:(?:Sony|Canon|Leica)\s+)?(PL|EF(?:-S)?|RF|E|L)\b/gi))
      if (positiveDetail(text, m.index!)) types.push(`adapter_${normalize(m[1])}_${normalize(m[2])}`);
  }
  const capacities = category === "card" || category === "ssd"
    ? [...text.matchAll(/\b(\d+(?:\.\d+)?)\s*(GB|TB)\b/gi)].filter(m => positiveDetail(text, m.index!)).map(m => `${Number(m[1])}${m[2].toLowerCase()}`) : [];
  const noun = pattern.exec(text);
  const prefix = noun ? text.slice(0, noun.index) : "";
  // Ignore model/capacity digits; only a separate quantity or explicit × marker counts.
  const quantityMatch = [...prefix.matchAll(/(?:^|\s)(one|two|three|four|five|six|seven|eight|nine|ten|\d+)(?:\s*[x×]\s*|\s+|$)/gi)]
    .find(m => !/^(?:GB|TB)\b/i.test(prefix.slice(m.index! + m[0].length).trim()));
  const suffixQuantity = noun ? /^\s*(?:\((?:x|×)?\s*)?(\d+)\s*(?:[x×]\s*)?(?:\)|$)/i.exec(text.slice(noun.index + noun[0].length)) : null;
  const sets = /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s*[x×]?\s*sets?\b/i.exec(text);
  const quantityUnit=/\bsets?\b/i.test(text)?"sets" as const:"units" as const;
  const quantity = quantityUnit === "sets" ? (sets ? numbers[sets[1].toLowerCase()] ?? Number(sets[1]) : undefined)
    : quantityMatch ? (numbers[quantityMatch[1].toLowerCase()] ?? Number(quantityMatch[1]))
    : suffixQuantity ? Number(suffixQuantity[1]) : undefined;
  return { types, capacities, quantity, quantityUnit };
}
function supports(claim: ComponentDetails, proof: ComponentDetails) {
  return claim.types.every(t => proof.types.includes(t) || t === "cfexpress" && proof.types.some(p => p.startsWith("cfexpresstype")))
    && claim.capacities.every(c => proof.capacities.includes(c))
    && (claim.quantity === undefined || claim.quantity === proof.quantity && claim.quantityUnit === proof.quantityUnit);
}
const componentParts = (s: string) => s.split(/[,;()]|\balong\s+with\b|\bwith\b|\band\b|\bplus\b/gi);
/** Negative/optional offers are not claims of included contents. Preserve item attribution. */
export function unsupportedKitClaims(text: string, evidence: KitEvidence[], initialNames: string[] = []) {
  const failures: { sentence: string; content: string }[] = [];
  const selected = evidence.filter(e => e.names.some(n => initialNames.some(i => normalize(i) === normalize(n))));
  let subject: KitEvidence[] = selected.length === 1 ? selected : [];
  let includedList = false;
  for (const sentence of text.split(/(?<=[.!?])\s+|\n/)) {
    if (!sentence.trim()) continue;
    const named = evidence.filter(e => e.names.some(name => name && namesItem(sentence, name)));
    if (named.length) subject = named;
    const match = /\b(?:comes with|ships with|bundled with|includes?|included)\b/i.exec(sentence);
    const bullet = includedList && /^\s*(?:[-•*]\s+|\d+\s*[x×]\s+)/i.test(sentence);
    if (!match && !bullet) { includedList = false; continue; }
    if (/\b(?:does not|doesn't|not|without)\s+(?:come|ship|include)/i.test(sentence)) { includedList = false; continue; }
    if (match) includedList = /:\s*$/.test(sentence);
    let claimed = match ? sentence.slice(match.index + match[0].length) : sentence;
    if (match?.[0].toLowerCase() === "included") claimed = sentence;
    claimed = claimed.split(/\b(?:but not|except|excluding|without)\b/i)[0];
    // Preserve the attribution through component-list splitting at "with".
    claimed = claimed.replace(/\bincluded\s+(?:with|in)\s+your\s+(?:(?:booked|rental)\s+)?camera(?:\s+kit)?\b/gi, "included_with_your_camera");
    const candidates = named.length ? named : subject.length ? subject : evidence;
    if (!candidates.length) continue; // unknown-kit guard handles missing evidence separately
    for (const [content, pattern] of categories) {
      const claims = componentParts(claimed.replace(/\b(?:built[ -]?in|internal)\s+(?:variable\s+)?ND\s+filters?\b/gi, "intrinsic camera ND")).filter(c => !/^\s*(?:not|no|without|rather than|instead of)\b/i.test(c) && pattern.test(c));
      if (claims.some(raw => {
        const owners = raw.includes("included_with_your_camera") ? evidence.filter(e => e.booked_camera) : candidates;
        const claim = details(raw, content, pattern);
        return !owners.length || !owners.every(e => e.contents.some(entry =>
          componentParts(entry).some(part => pattern.test(part) && supports(claim, details(part, content, pattern)))));
      })) {
        failures.push({ sentence: sentence.trim(), content });
      }
    }
  }
  return failures;
}
