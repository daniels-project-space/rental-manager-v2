/**
 * V1 negotiation strategy — pure-function port.
 *
 * Pure TypeScript, no Convex deps. Called by the `get_negotiation_stance`
 * tool with thread history + latest message. Returns the V1 ladder result
 * the agent then weaves into the draft.
 *
 * Per spec §D — 3-stage ladder:
 *   objections == 1 → HOLD_FIRM
 *   objections == 2 → OFFER_ALTERNATIVES
 *   objections >= 3 → SOFT_YIELD (escalate-to-Daniel framing)
 *
 * Plus a competitor branch that adds an explicit acknowledgment line
 * regardless of objection count.
 */

export type NegotiationStance =
  | "NONE"
  | "HOLD_FIRM"
  | "OFFER_ALTERNATIVES"
  | "SOFT_YIELD";

export interface NegotiationInput {
  /** Latest renter message (last inbound, lowercased not required). */
  latestMessage: string;
  /** All prior renter messages in the thread, oldest first. */
  priorRenterMessages: string[];
  /** Last price the bot has surfaced this thread, if any. */
  lastPriceOfferedGbp?: number | null;
  /** Whether the renter is a high-value (≥3 prior rentals or £500+ spend). */
  isHighValue?: boolean;
}

export interface NegotiationOutput {
  stance: NegotiationStance;
  objectionCount: number;
  competitorMentioned: boolean;
  suggestedFraming: string;
  lastPriceOfferedGbp: number | null;
  /** Whether the agent has discount authority to surface NOW. */
  discountAuthority: "none" | "may_offer_alternatives" | "may_escalate";
}

// ── V1 regex banks (verbatim) ─────────────────────────────────

const NEGOTIATION_PATTERNS =
  /\b(too expensive|lower price|better deal|best price|negotiate|can you do .* for|feels? steep|saw.*cheaper|over.?priced|rip.?off|found.*cheaper|another.*rental|price match|beat.*price|cheaper.*elsewhere|match.*price|any discount|any deal)\b/i;

const COMPETITOR_PATTERNS =
  /\b(saw.*cheaper|found.*cheaper|another.*rental|competitor|cheaper.*elsewhere|price.*match|beat.*price)\b/i;

function countObjections(messages: string[]): number {
  let n = 0;
  for (const m of messages) if (NEGOTIATION_PATTERNS.test(m)) n += 1;
  return n;
}

// ── Framing copy (V1 verbatim, lightly compacted) ──────────────

const FRAMING = {
  NONE: "No negotiation framing — quote the listed price normally.",
  COMPETITOR_ACK:
    "Open with: 'I appreciate you sharing that — our prices reflect professional maintenance and support. Let me see what I can do.' Then proceed with the stance.",
  HOLD_FIRM:
    "First pushback. Emphasise value: professional gear, flexible logistics, insurance coverage. Mention multi-day savings if the dates qualify. DO NOT offer a discount.",
  OFFER_ALTERNATIVES:
    "Suggest: (1) longer rental for better daily rate, (2) alternative gear at a lower price point. If a pre-approved discount applies (distance / 7+ days), surface it here — never reveal thresholds or %.",
  SOFT_YIELD:
    "If a pre-approved discount applies, surface now. Else: 'Let me check with Daniel for a special rate.' NEVER go below cost. If still unsatisfied, gracefully offer them time to compare options.",
} as const;

// ── Public API ────────────────────────────────────────────────

export function computeNegotiationStance(
  input: NegotiationInput,
): NegotiationOutput {
  const all = [...input.priorRenterMessages, input.latestMessage];
  const objectionCount = countObjections(all);
  const competitorMentioned = all.some((m) => COMPETITOR_PATTERNS.test(m));

  let stance: NegotiationStance = "NONE";
  let framing: string = FRAMING.NONE;
  let authority: NegotiationOutput["discountAuthority"] = "none";

  if (objectionCount === 0 && !competitorMentioned) {
    return {
      stance: "NONE",
      objectionCount: 0,
      competitorMentioned: false,
      suggestedFraming: FRAMING.NONE,
      lastPriceOfferedGbp: input.lastPriceOfferedGbp ?? null,
      discountAuthority: "none",
    };
  }

  if (objectionCount >= 3) {
    stance = "SOFT_YIELD";
    framing = FRAMING.SOFT_YIELD;
    authority = "may_escalate";
  } else if (objectionCount === 2) {
    stance = "OFFER_ALTERNATIVES";
    framing = FRAMING.OFFER_ALTERNATIVES;
    authority = "may_offer_alternatives";
  } else if (objectionCount === 1) {
    stance = "HOLD_FIRM";
    framing = FRAMING.HOLD_FIRM;
    authority = "none";
  }

  if (competitorMentioned) {
    framing = `${FRAMING.COMPETITOR_ACK}\n${framing}`;
  }

  return {
    stance,
    objectionCount,
    competitorMentioned,
    suggestedFraming: framing,
    lastPriceOfferedGbp: input.lastPriceOfferedGbp ?? null,
    discountAuthority: authority,
  };
}
