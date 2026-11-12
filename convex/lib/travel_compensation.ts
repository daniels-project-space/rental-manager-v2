import { completeRentalTotal } from "./minimum_rental";
import type { PriceEvidence } from "./price_claims";
import type { StockRequest } from "./stock_claims";

export type TravelCompensationTurn = { role: "owner" | "renter"; content: string };

export type TravelCompensationAssessment = {
  eligible: boolean;
  pickupAreaDisclosed: boolean;
  renterObjected: boolean;
  alreadyOffered: boolean;
  maximumGbp: number | null;
};

export function travelCompensationMaximum(rentalChargeGbp: number | null | undefined): number | null {
  if (rentalChargeGbp == null || !Number.isFinite(rentalChargeGbp) || rentalChargeGbp <= 0) return null;
  return Math.min(Math.floor(rentalChargeGbp * 10 + 1e-7) / 100, 10);
}

/** Use a paid rental amount or a complete exact-date Native quote. Daily rates,
 * partial item prices and alternative quotes do not establish the cap base. */
export function verifiedRentalChargeGbp(input: {
  rentalChargeGbp?: number | null;
  grossPaidGbp?: number | null;
  deliveryFeeGbp?: number | null;
  priceEvidence?: PriceEvidence[];
  priceRequest?: StockRequest;
}): number | null {
  const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0;
  if (positive(input.rentalChargeGbp)) return input.rentalChargeGbp;
  if (positive(input.grossPaidGbp)) {
    const rental = Math.max(0, input.grossPaidGbp - (input.deliveryFeeGbp ?? 0));
    if (positive(rental)) return rental;
  }
  if (input.priceEvidence?.length && input.priceRequest) {
    const { start_date, end_date } = input.priceRequest;
    if (!start_date || !end_date) return null;
    const dateMatchedEvidence = input.priceEvidence.filter(
      (evidence) => evidence.start_date === start_date && evidence.end_date === end_date,
    );
    const exact = completeRentalTotal(dateMatchedEvidence, input.priceRequest);
    if (exact && positive(exact.total)) return exact.total;
  }
  return null;
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean);
}

function isPositiveDiscountSentence(sentence: string): boolean {
  if (/\b(?:can't|cannot|won't|wouldn't|unable to|not able to|not allowed to|don't|do not)\s+(?:(?:offer|give|apply|provide|discount|reduce|do)\b|take\b.{0,24}\boff\b)/i.test(sentence) ||
    /\b(?:isn't|aren't|is not|are not|won't be|wouldn't be|can't be|cannot be|not)\s+(?:made\s+)?available\b/i.test(sentence)) {
    return false;
  }
  const hasOfferVerb = /\b(?:offer|apply|give|provide|reduce|discount|compensat(?:e|ion)|take off|make up for|offset|credit|can do)\b/i.test(sentence) ||
    /\btake\b.{0,16}\boff\b/i.test(sentence) ||
    /\b(?:is|are|would be|will be|can be)\s+(?:made\s+)?available\b/i.test(sentence);
  const hasMoney = /£\s?\d+(?:\.\d{1,2})?|\b\d+(?:\.\d+)?\s?%/i.test(sentence);
  const hasNamedTravelRelief = /\b(?:travel|journey|distance|trip)\s+(?:discount|adjustment|compensation|credit)\b/i.test(sentence);
  return hasOfferVerb && (hasMoney || hasNamedTravelRelief);
}

/** A positive monetary concession, regardless of whether the model calls it travel relief. */
export function isDiscountConcessionOffer(text: string): boolean {
  return sentences(text).some(isPositiveDiscountSentence);
}

export function discountConcessionExceedsCap(text: string, rentalChargeGbp: number | null | undefined, maximumGbp: number | null): boolean {
  if (maximumGbp == null || rentalChargeGbp == null || !Number.isFinite(rentalChargeGbp)) return true;
  const offers = sentences(text).filter(isPositiveDiscountSentence);
  if (!offers.length) return false;
  for (const sentence of offers) {
    const amounts = [...sentence.matchAll(/£\s?(\d+(?:\.\d{1,2})?)/gi)].map((match) => Number(match[1]));
    const percentages = [...sentence.matchAll(/\b(\d+(?:\.\d+)?)\s?%/gi)].map((match) => Number(match[1]) * rentalChargeGbp / 100);
    const values = [...amounts, ...percentages];
    if (!values.length || values.some((value) => value > maximumGbp + 0.001)) return true;
  }
  return false;
}

export function isTravelCompensationOffer(text: string): boolean {
  return sentences(text).some((sentence) =>
    isPositiveDiscountSentence(sentence) && /\b(?:travel|journey|distance|trip|collection|pick\s?up)\b/i.test(sentence),
  );
}

export function isPickupLocationIntent(message: string): boolean {
  // A renter can ask about the business location without naming a pickup or
  // one of the handful of areas in a listing. Recognise the question's shape,
  // while leaving unrelated phrases such as "price based on duration" alone.
  const businessLocationQuestion = /\bwhere\s+(?:are|is)\s+(?:you|your\s+(?:business|company|shop|studio))\s+(?:based|located|situated)\b/i.test(message) ||
    /\b(?:are|is)\s+(?:you|your\s+(?:business|company|shop|studio))\s+(?:based|located|situated)\s+(?:in|at|near|around)\b/i.test(message) ||
    (/\b(?:your|the)\s+(?:[\w'-]+\s+){0,4}(?:branch|shop|studio|store|office)\b/i.test(message) &&
      /\b(?:where|real|really|exists?|correct|right|genuine|true|listed|listing|address|location)\b/i.test(message));
  if (businessLocationQuestion) return true;
  // "Delivery and collection" commonly means the courier's round trip, not
  // a request for the renter's own pickup point. Keep that price answer unless
  // the renter also asks explicitly about collecting in person or pickup details.
  const courierRoundTrip = /\b(?:deliver(?:y|ed)?|courier)\b/i.test(message) && /\b(?:collection|collect|pick[ -]?up)\b/i.test(message);
  const asksOwnPickup = /\b(?:can|could|would|where|when)\s+(?:i|we)\s+(?:collect|pick[ -]?up)\b/i.test(message) ||
    /\b(?:collect|pick[ -]?up)\s+(?:it\s+)?(?:myself|ourselves|in person)\b/i.test(message) ||
    /\b(?:is|are|was)\s+(?:the\s+)?(?:pickup|pick[ -]?up|collection)\s+(?:in|at|near|from)\b/i.test(message) ||
    /\b(?:where|which|what|your)\b.{0,35}\b(?:pickup|pick[ -]?up|collection)\s+(?:address|postcode|point|location|area)\b/i.test(message) ||
    /\bwhere\b.{0,25}\b(?:pickup|pick[ -]?up|collection|collect)\b/i.test(message);
  if (courierRoundTrip && !asksOwnPickup) return false;
  const hasLocationTarget = /\b(?:pickup|pick[ -]?up|collection|collect|address|postcode|street|location|meeting point|meetup|shoreditch|camden|trafalgar(?: square)?|northumberland(?: street)?|charing cross)\b/i.test(message);
  if (!hasLocationTarget) return false;
  // Short follow-ups such as "so not Shoreditch?" inherit their meaning from
  // the previous turn, so do not require the renter to repeat "pickup".
  if (/\b(?:so|then)\s+not\b/i.test(message)) return true;
  return /\b(?:where|which area|what area|exact|postcode|real|really|actually|correct|right|genuine|true|confirm|whether|listed|listing says|tell me|share|send me)\b/i.test(message) ||
    /\b(?:which|what)\s+(?:pickup\s+)?(?:street|address)\b|\bstreet\s+address\b/i.test(message) ||
    /\b(?:i thought|i understood|i was told|i expected|i was expecting|the listing (?:says|shows|states)|the ad (?:says|shows)|it (?:says|shows))\b.{0,80}\b(?:pickup|pick[ -]?up|collection|at|in|near)\b/i.test(message) ||
    /\b(?:can|could|would|should)\s+(?:i|we|you)\s+(?:(?:still|then|there)\s+)?(?:collect|pick[ -]?up|meet|get|come)\b/i.test(message) ||
    /\b(?:is|are|was|does)\b.{0,40}\b(?:pickup|pick[ -]?up|collection|location|shoreditch|camden|trafalgar|northumberland|charing cross)\b/i.test(message) ||
    /\b(?:pickup|pick[ -]?up|collection|location)\b.{0,35}\b(?:in|at|near|from)\b/i.test(message);
}

/** A grounded explanation that an item's collection is tied to its account pickup point. */
export function hasPickupHandoffExplanation(text: string): boolean {
  return sentences(text).some((sentence) =>
    /\b(?:only available|available only|can only be (?:collected|picked up)|collection is only available|pickup is only available)\b/i.test(sentence) &&
    /\b(?:collection|pickup|collect|collected|pick[ -]?up|picked up)\b/i.test(sentence),
  );
}

export function isTravelConcern(message: string): boolean {
  return /\b(?:travel|journey|distance|trip|commute|route|too far|long way|far for me|far from me|far away|bit far|quite far|out of my way|inconvenient)\b/i.test(message);
}

export function isUnsafePickupLocationClaim(text: string): boolean {
  return /\b(?:fake|doesn['’]?t exist|does not exist|nonexistent|not a real location|isn['’]?t real|not real|only one (?:central )?(?:pickup|collection|location)|currently consolidat(?:ing|ed)|(?:rather than|instead of)\s+(?:shoreditch|camden))\b/i.test(text);
}

export function mentionsPickupArea(text: string, pickupArea: string | null | undefined): boolean {
  const area = pickupArea?.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .filter((token) => token.length > 2 && !["area", "near", "the", "outside"].includes(token));
  if (!area?.length) return false;
  const message = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ");
  return area.every((token) => message.includes(token));
}

function disclosedArea(history: TravelCompensationTurn[], pickupArea: string | null | undefined): boolean {
  return history.some((turn) => {
    if (turn.role !== "owner") return false;
    return mentionsPickupArea(turn.content, pickupArea);
  });
}

function explicitTravelObjection(message: string): boolean {
  return /\b(?:too\s+far|long\s+(?:way|journey|trip|drive)|(?:bit|quite|a little)\s+far|far\s+(?:for me|from me|away)|distance\s+(?:is\s+)?(?:too much|too far|an issue|a problem|long)|(?:too much|a lot of)\s+travel|travel\s+(?:costs?|expenses?|is\s+(?:too much|expensive|far)|feels\s+(?:too much|expensive))|extra\s+travel|hard\s+to\s+get\s+to|inconvenient|doesn'?t\s+work\s+for\s+me|out\s+of\s+my\s+way|pickup.{0,20}\b(?:too far|far|a long way)\b)\b/i.test(message);
}

export function assessTravelCompensation(input: {
  history: TravelCompensationTurn[];
  lastRenterMessage: string;
  pickupArea?: string | null;
  rentalChargeGbp?: number | null;
}): TravelCompensationAssessment {
  const pickupAreaDisclosed = disclosedArea(input.history, input.pickupArea);
  const renterObjected = explicitTravelObjection(input.lastRenterMessage);
  const alreadyOffered = input.history.some((turn, index) =>
    turn.role === "owner" && isDiscountConcessionOffer(turn.content) &&
    (isTravelCompensationOffer(turn.content) || input.history.slice(0, index).some((prior) =>
      prior.role === "renter" && (isTravelConcern(prior.content) || isPickupLocationIntent(prior.content)),
    )),
  );
  const maximumGbp = travelCompensationMaximum(input.rentalChargeGbp);
  return {
    eligible: pickupAreaDisclosed && renterObjected && !alreadyOffered && maximumGbp != null,
    pickupAreaDisclosed,
    renterObjected,
    alreadyOffered,
    maximumGbp,
  };
}

export function replaceTravelCompensationOffers(text: string, maximumGbp: number): string {
  const amount = `£${maximumGbp.toFixed(2)}`;
  return sentences(text)
    .map((sentence) => isPositiveDiscountSentence(sentence)
      ? `I can offer a one-time ${amount} travel adjustment on this rental.`
      : sentence)
    .join(" ")
    .trim();
}

/** Exclude only the exact adjustment that the policy gate has already authorized
 * from ordinary price validation. Other prices in the reply remain checked. */
export function withoutAuthorizedTravelCompensationClaim(text:string,maximumGbp:number|null,authorized:boolean):string {
  if(!authorized||maximumGbp==null)return text;
  const canonical=`I can offer a one-time £${maximumGbp.toFixed(2)} travel adjustment on this rental.`;
  const escaped=canonical.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  return text.replace(new RegExp(escaped,"gi"),"");
}

export function stripTravelCompensationOffers(text: string): string {
  return sentences(text)
    .filter((sentence) => !isPositiveDiscountSentence(sentence))
    .join(" ")
    .trim();
}
