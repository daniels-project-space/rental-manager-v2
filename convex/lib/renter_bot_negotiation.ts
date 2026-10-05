import {PRIMARY_RENTAL_REQUEST,sameRentalRequest,type RentalRequest} from "./rental_request";
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

import type {SentInquiryOffer} from './sent_inquiry_offer';
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
  /** Strategy only; monetary reductions still require current Native policy/approval. */
  discountAuthority: "none" | "may_offer_alternatives" | "may_escalate";
}

/** Same bounded Native history for drafting and the Mastra tool. */
export const NEGOTIATION_HISTORY_LIMIT=50;
export function negotiationFromMessages(messages:Array<{message_id?:string;sender:string;body_text:string;rental_request?:RentalRequest;quoted_inquiries?:SentInquiryOffer[]}>,selected?:RentalRequest) {
  const request=selected??messages.filter(m=>m.sender==="owner"&&m.rental_request).at(-1)?.rental_request??PRIMARY_RENTAL_REQUEST;
  // Tagged renter turns are authoritative. Untagged legacy history belongs to
  // the primary booking; newer unsent turns inherit the last served request.
  let active:RentalRequest=request.kind==="inquiry"&&!messages.some(m=>m.message_id===request.origin_message_id||m.rental_request)?request:PRIMARY_RENTAL_REQUEST;
  const scoped=messages.filter((message,index)=>{
    if(message.rental_request)active=message.rental_request;
    else if(request.kind==="inquiry"&&message.message_id===request.origin_message_id)active=request;
    const current=message.sender==="renter"&&index===messages.length-1&&!message.rental_request?request:active;
    return sameRentalRequest(current,request);
  });
  const renterMessages=scoped.filter(message=>message.sender==="renter").map(message=>message.body_text);
  const latestOptions=scoped.filter(message=>message.sender==="owner"&&message.quoted_inquiries?.length).at(-1)?.quoted_inquiries??[];
  const latestOffer=latestOptions.length===1?latestOptions[0]:null;
  return {...computeNegotiationStance({latestMessage:renterMessages.at(-1)??"",priorRenterMessages:renterMessages.slice(0,-1),
    lastPriceOfferedGbp:latestOffer?.quote.listing_quote?.total_gbp??null}),rentalRequest:request,
    threadObjectionCount:countObjections(messages.filter(m=>m.sender==="renter").map(m=>m.body_text)),
    lastInquiryOffer:latestOffer,...(latestOptions.length>1?{lastInquiryOptions:latestOptions}:{})};
}

// Price objections require price language; another hire or a delivery request
// alone is not negotiation. Shared by drafting and the Native Mastra tool.

const NEGOTIATION_PATTERNS =
  /\b(too expensive|lower price|better deal|best price|negotiate|can you do .* for\s*(?:£\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:pounds?|quid)|GBP\s*\d+(?:\.\d+)?)|feels? steep|saw.*cheaper|over.?priced|rip.?off|found.*cheaper|price match|beat.*price|cheaper.*elsewhere|match.*price|any discount|any deal)\b/i;

const COMPETITOR_PATTERNS =
  /\b(saw.*cheaper|found.*cheaper|competitor|cheaper.*elsewhere|price.*match|beat.*price)\b/i;

function countObjections(messages: string[]): number {
  let n = 0;
  for (const m of messages) if (NEGOTIATION_PATTERNS.test(m)) n += 1;
  return n;
}

// The tool supplies strategy, not business facts or financial approval.
// Both the draft context and Mastra consume this same guidance.
const FRAMING = {
  NONE: "No current price objection. Answer the current request using its verified facts; do not introduce a discount or repeat an unrelated quote.",
  COMPETITOR_ACK:
    "Acknowledge the comparison politely without disparaging the competitor. Explain value only from verified item facts and current policy; do not invent coverage, service or logistical benefits.",
  HOLD_FIRM:
    "First pushback: hold the verified quoted price. Briefly explain the relevant verified gear or included contents. Offer multi-day savings only if a Native dated quote proves the saving for the requested gear. Do not offer a discount.",
  OFFER_ALTERNATIVES:
    "Offer suitable lower-cost owned gear using find_owned_alternatives and a dated Native basket quote. Preserve the renter's requirements and explain any verified trade-offs. If their dates are flexible, compare Native quotes for a longer hire; a lower daily rate does not mean a lower total. A policy discount requires current search_knowledge evidence that it applies to this request and a verified resulting quote; this stance supplies no monetary approval.",
  SOFT_YIELD:
    "Repeated price pushback: use a current applicable policy and verified quote for any authorized reduction; never undercut an applicable verified pricing floor. Otherwise offer an owner review of a special-rate request, without promising approval, a price or a response time. Keep suitable owned alternatives available and let the renter consider the offer without pressure. Historical offers and this stance supply no monetary approval.",
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

  // History is context, not authority to negotiate on a logistics/acceptance
  // turn. Activate the ladder only for a current price objection.
  if (!NEGOTIATION_PATTERNS.test(input.latestMessage)) {
    return {
      stance: "NONE",
      objectionCount,
      competitorMentioned,
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
