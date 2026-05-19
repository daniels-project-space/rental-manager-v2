/**
 * Hard-filter banks — port of V1's `src/pipeline/filter.ts` + `patterns.ts`.
 *
 * Pure TypeScript, no Convex runtime deps. Run AFTER the LLM emits a draft
 * and BEFORE the draft hits Telegram. Each violation has one of four
 * actions:
 *   - "strip":     rewrite the draft, removing the violating fragment
 *   - "rewrite":   ask the LLM to regenerate with a hint
 *   - "flag":      allow the draft through but tag it red
 *   - "block":     reject; regen up to 2× then escalate to human
 *
 * Decision A-6: filter strictness = block + regenerate up to 2× + flag-
 * and-forward to Telegram with red banner if still bad.
 *
 * Per spec §E. Names match V1.
 */

export type FilterAction = "strip" | "rewrite" | "flag" | "block";

export interface FilterViolation {
  category: string;
  action: FilterAction;
  matchedText?: string;
  hint?: string;
}

export interface FilterResult {
  ok: boolean;                        // true ⇔ no blocking violations remain
  violations: FilterViolation[];
  stripped: string;                   // draft with strip-class fragments removed
}

// ── Pattern banks ─────────────────────────────────────────────

/** "I'm here / on my way / at the location" — bot has no physical body. */
const PHYSICAL_PRESENCE = [
  /\bI(?:'m| am)\s+(?:here|on my way|at the location|at the (?:shop|warehouse|pickup))/i,
  /\bI(?:'ll| will)\s+(?:meet you|see you there|come outside)\b/i,
  /\bI(?:'m| am)\s+heading\s+(?:over|down|out)\b/i,
  /\bI(?:'m| am)\s+just (?:outside|round the corner|nearby)\b/i,
];

/** Bot quotes something the renter never actually said. */
const FABRICATED_QUOTE = [
  /(?:you|she|he|they)\s+(?:said|mentioned|wrote|asked)\s+["'][^"']+["']/i,
];

/** Stage directions / internal action leakage. */
const INTERNAL_ACTION = [
  /\*[^*]+\*/g,                                            // *informs Daniel*
  /\[(?:checks|looks up|reviews|consults)[^\]]*\]/gi,
];

/** Platform names — bot must never name Hygglo / Fat Llama to the renter. */
const PLATFORM_LEAK = [
  /\bhygglo\b/i,
  /\bfat\s*llama\b/i,
  /\bvia\s+the\s+platform\b/i,
];

/** Off-hours times agreed to. Working hours: 10am-12pm OR 7-9pm. */
const INVALID_TIME_ACCEPTED = [
  /\bsee you at\s+(?:1|2|3|4|5|6)\s*pm\b/i,
  /\b(?:pickup|collection)\s+at\s+(?:1|2|3|4|5|6)\s*pm\b/i,
  /\bok(?:ay)?\s+(?:for\s+)?(?:1|2|3|4|5|6)\s*pm\b/i,
];

/** Reasoning leak — chain-of-thought escaping to renter. */
const CHAIN_OF_THOUGHT = [
  /^(?:Let me think|First, |So, |Okay, so|Let's see)/im,
  /\bbased on (?:the|my) (?:reasoning|analysis|context)\b/i,
];

/** Timestamp prefix leak — `[2026-05-18 19:30]` accidentally rendered. */
const TIMESTAMP_LEAK = [
  /^\s*\[\d{4}-\d{2}-\d{2}[\sT][\d:]+\]\s*/gm,
];

/**
 * V1's most-blocked pattern. Renter-bot must NEVER ask "what's the shoot
 * for?" or any qualifying-the-renter spam.
 */
const QUALIFY_QUESTION_SPAM = [
  /\bwhat(?:'s| is)?\s+the\s+(?:shoot|project|production)\s+for\b/i,
  /\bwhat(?:'s| are you)\s+(?:filming|shooting|using\s+this\s+for)\b/i,
  /\bwhat\s+kind\s+of\s+(?:shoot|project|production)\b/i,
  /\btell me (?:more )?about (?:the|your) (?:shoot|project|production)\b/i,
  /\bwho(?:'s| is) (?:the|your) (?:DP|director|client)\b/i,
];

/** Upsell language — DANIEL forbids pushiness. */
const UPSELL_LANGUAGE = [
  /\bmost (?:people|customers|renters) (?:also|usually) (?:grab|add|pair|bundle)\b/i,
  /\bpair (?:it )?with\b/i,
  /\byou might (?:also )?want\b/i,
  /\bothers (?:often )?go (?:for|with)\b/i,
  /\bcustomers (?:like you )?(?:also|often) book\b/i,
  /\bif you('re)?\s+looking\s+to\s+upgrade\b/i,
];

/** Proactive delivery offer — only when renter asks (DANIEL RULE — Delivery). */
const PROACTIVE_DELIVERY = [
  /\bwe (?:can|could) (?:also )?deliver\b/i,
  /\bhappy to (?:arrange|sort) delivery\b/i,
  /\bdelivery is (?:available|an option)\b/i,
];

/** Premature confirmation — DANIEL RULE 20 blocks "accepted"/"booked" before approval. */
const PREMATURE_CONFIRMATION = [
  /\b(?:I(?:'ve| have))?\s*(?:accepted|approved|booked|confirmed)\s+your\s+(?:request|rental|booking)\b/i,
  /\byou(?:'re| are) (?:all )?(?:booked|set|confirmed)\b/i,
];

/** Bot claims an action it didn't perform (booked, sent, refunded etc). */
const FALSE_ACTION_CLAIM = [
  /\bI(?:'ve| have) (?:just )?(?:sent|emailed|forwarded|refunded|booked|cancelled)\b/i,
];

/**
 * "Our location" without naming Trafalgar Square / Sainsbury Wing.
 * Per DANIEL RULE 19 + arrival reminder rules: address MUST be explicit.
 * This one is FLAG, not block — allows polite agreement messages through.
 */
const VAGUE_CONFIRMED_LOCATION = [
  /\bat (?:our|the) (?:location|spot|place)\b/i,
];

/** Internal pricing disclosure — never reveal margins / fees / thresholds. */
const INTERNAL_PRICING_DISCLOSURE = [
  /\bour (?:profit\s+)?margin\b/i,
  /\bplatform\s+(?:fee|commission)\s+(?:is|of)\s*\d/i,
  /\b(?:we|our)\s+(?:net|keep|earn)\s*\d/i,
  /\bservice\s+fee\s+(?:is|of)\s*\d/i,
];

// ── Apply each bank ──────────────────────────────────────────

function findHits(text: string, patterns: RegExp[]): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    p.lastIndex = 0;
    const m = text.match(p);
    if (m) out.push(m[0]);
  }
  return out;
}

function strip(text: string, patterns: RegExp[]): string {
  let out = text;
  for (const p of patterns) out = out.replace(p, "");
  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * Run all V1 hard filters against a draft. Returns:
 *   - violations: every category that hit (with action label)
 *   - stripped: the draft with strip-class fragments removed
 *   - ok: true ⇔ no `block` or `rewrite` violations
 *
 * Caller logic (per Decision A-6):
 *   if (!ok && retryCount < 2)  → ask LLM to regen with `hints`
 *   if (!ok && retryCount >= 2) → forward to Telegram with red banner
 *   if (ok && flags.length)     → forward to Telegram with yellow chips
 */
export function applyRenterBotFilters(draft: string): FilterResult {
  const violations: FilterViolation[] = [];
  const tag = (cat: string, action: FilterAction, hits: string[], hint?: string) => {
    for (const h of hits) {
      violations.push({ category: cat, action, matchedText: h, hint });
    }
  };

  tag("PHYSICAL_PRESENCE", "block", findHits(draft, PHYSICAL_PRESENCE),
    "You are not physically present. Never imply you are.");
  tag("FABRICATED_QUOTE", "block", findHits(draft, FABRICATED_QUOTE),
    "Do not invent renter quotes. Only quote what the renter wrote verbatim.");
  tag("PLATFORM_LEAK", "strip", findHits(draft, PLATFORM_LEAK));
  tag("CHAIN_OF_THOUGHT", "strip", findHits(draft, CHAIN_OF_THOUGHT));
  tag("TIMESTAMP", "strip", findHits(draft, TIMESTAMP_LEAK));
  tag("INTERNAL_ACTION", "strip", findHits(draft, INTERNAL_ACTION));
  tag("INVALID_TIME_ACCEPTED", "block", findHits(draft, INVALID_TIME_ACCEPTED),
    "Working hours are 10am-12pm and 7-9pm only. Suggest a slot inside that window.");
  tag("QUALIFY_QUESTION_SPAM", "strip", findHits(draft, QUALIFY_QUESTION_SPAM));
  tag("UPSELL_LANGUAGE", "strip", findHits(draft, UPSELL_LANGUAGE));
  tag("PROACTIVE_DELIVERY", "strip", findHits(draft, PROACTIVE_DELIVERY));
  tag("PREMATURE_CONFIRMATION", "block", findHits(draft, PREMATURE_CONFIRMATION),
    "Never say accepted/booked/confirmed before Daniel has approved on the platform.");
  tag("FALSE_ACTION_CLAIM", "block", findHits(draft, FALSE_ACTION_CLAIM),
    "Do not claim to have performed actions you can't perform.");
  tag("INTERNAL_PRICING_DISCLOSURE", "block", findHits(draft, INTERNAL_PRICING_DISCLOSURE),
    "Never reveal margins, fees, commissions, or net earnings.");
  tag("VAGUE_CONFIRMED_LOCATION", "flag", findHits(draft, VAGUE_CONFIRMED_LOCATION),
    "Be explicit about the pickup location (Trafalgar Square, statue of James the Second).");

  // Apply strip-class rewrites in order.
  let stripped = draft;
  stripped = strip(stripped, PLATFORM_LEAK);
  stripped = strip(stripped, CHAIN_OF_THOUGHT);
  stripped = strip(stripped, TIMESTAMP_LEAK);
  stripped = strip(stripped, INTERNAL_ACTION);
  stripped = strip(stripped, QUALIFY_QUESTION_SPAM);
  stripped = strip(stripped, UPSELL_LANGUAGE);
  stripped = strip(stripped, PROACTIVE_DELIVERY);

  const blocking = violations.filter((v) => v.action === "block" || v.action === "rewrite");
  return { ok: blocking.length === 0, violations, stripped };
}

/**
 * Build a single-string hint paragraph for the LLM regen prompt. Used by
 * the workflow's filter-retry step. Returns "" when no blocking hints.
 */
export function buildFilterHint(result: FilterResult): string {
  const hints = result.violations
    .filter((v) => v.action === "block" || v.action === "rewrite")
    .filter((v) => !!v.hint)
    .map((v) => `- [${v.category}] ${v.hint}`);
  if (hints.length === 0) return "";
  return [
    "Your previous draft hit the following hard filters — REGENERATE addressing each:",
    ...hints,
  ].join("\n");
}
