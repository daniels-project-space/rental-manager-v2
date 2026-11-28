import { completeRentalTotal } from "./minimum_rental";
import type { PriceEvidence } from "./price_claims";
import type { StockRequest } from "./stock_claims";

export type TravelCompensationTurn = { role: "owner" | "renter"; content: string };

export type TravelCompensationAssessment = {
  eligible: boolean;
  pickupAreaDisclosed: boolean;
  pickupAreaAccepted: boolean;
  renterObjected: boolean;
  alreadyOffered: boolean;
  maximumGbp: number | null;
};

export function travelCompensationMaximum(rentalChargeGbp: number | null | undefined): number | null {
  if (rentalChargeGbp == null || !Number.isFinite(rentalChargeGbp) || rentalChargeGbp <= 0) return null;
  const maximum = Math.min(Math.floor(rentalChargeGbp * 10 + 1e-7) / 100, 10);
  return maximum > 0 ? maximum : null;
}

/** Use a paid rental amount or a complete exact-date Native quote. Daily rates,
 * partial item prices and alternative quotes do not establish the cap base. */
export function verifiedRentalChargeGbp(input: {
  rentalChargeGbp?: number | null;
  grossPaidGbp?: number | null;
  deliveryFeeGbp?: number | null;
  /** Exact current Native inquiry quote; a rate estimate is not sufficient. */
  verifiedInquiryQuoteGbp?: number | null;
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
  if (positive(input.verifiedInquiryQuoteGbp)) return input.verifiedInquiryQuoteGbp;
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
  // A refusal can be followed by an authorized counter-offer in the same
  // sentence. Judge each clause so the first refusal does not hide the later
  // concession from the policy guard or stock-claim exclusion.
  const clauses = sentence.split(/[,;]\s*|\s+(?:but|however|yet|although|though)\s+/i).filter(Boolean);
  return clauses.some(isPositiveDiscountClause);
}

function isPositiveDiscountClause(sentence: string): boolean {
  // A completed order action is a confirmation, not a fresh offer. Keeping
  // it out of the offer detector prevents the next turn from treating an
  // applied adjustment as a second negotiation concession.
  if (/\b(?:i|we)\s+(?:(?:have|has)\s+|(?:'|’)ve\s+)?(?:just\s+|already\s+)?(?:applied|deducted|credited)\b/i.test(sentence)) return false;
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
    const explicitlyCapped = /\b(?:whichever|whatever)\s+(?:is\s+)?(?:the\s+)?(?:less|lower)\b|\b(?:lower|lesser)\s+of\b|\bup\s+to\b/i.test(sentence);
    if (!values.length || (explicitlyCapped ? Math.min(...values) : Math.max(...values)) > maximumGbp + 0.001) return true;
  }
  return false;
}

/** Resolve one explicit travel-compensation offer to the exact amount it promises. */
export function travelCompensationOfferAmountGbp(text: string, rentalChargeGbp: number | null | undefined): number | null {
  const maximum = travelCompensationMaximum(rentalChargeGbp);
  if (maximum == null) return null;
  const offers = sentences(text).filter(isTravelCompensationOffer);
  if (offers.length !== 1) return null;
  const sentence = offers[0];
  const amounts = [...sentence.matchAll(/£\s?(\d+(?:\.\d{1,2})?)/gi)].map((match) => Number(match[1]));
  const percentages = [...sentence.matchAll(/\b(\d+(?:\.\d+)?)\s?%/gi)].map((match) => Number(match[1]) * rentalChargeGbp! / 100);
  const values = [...amounts, ...percentages];
  if (!values.length) return null;
  const explicitlyCapped = /\b(?:whichever|whatever)\s+(?:is\s+)?(?:the\s+)?(?:less|lower)\b|\b(?:lower|lesser)\s+of\b|\bup\s+to\b/i.test(sentence);
  const amount = explicitlyCapped ? Math.min(...values) : values.every((value) => Math.abs(value - values[0]) < 0.001) ? values[0] : null;
  if (amount == null || amount <= 0 || amount > maximum + 0.001) return null;
  return Math.round(amount * 100) / 100;
}

export function isTravelCompensationOffer(text: string): boolean {
  return sentences(text).some((sentence) =>
    isPositiveDiscountSentence(sentence) && /\b(?:travel|journey|distance|trip|collection|pick\s?up)\b/i.test(sentence),
  );
}

/** Clear acceptance language is shared by Lab dispatch and the authoritative
 * order mutation. The current offer and all booking conditions are still
 * revalidated server-side; this only decides whether to attempt that action. */
export function clearlyAcceptsTravelCompensation(
  text: string,
  expectedAmountGbp?: number | null,
  rentalChargeGbp?: number | null,
): boolean {
  const normalized = text.toLowerCase().replace(/[’]/g, "'").replace(/[!?;,]/g, " ").replace(/\.(?!\d)/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (/\b(?:don't|do not|not|never|without|hold off|wait|maybe|perhaps)\b.{0,70}\b(?:apply|accept|take|discount|adjustment|compensation|offer)\b/i.test(normalized)) return false;
  if (/\b(?:later|not yet|after|once|when)\b.{0,70}\b(?:apply|accept|take|discount|adjustment|compensation|offer)\b|\b(?:apply|accept|take|discount|adjustment|compensation|offer)\b.{0,70}\b(?:later|not yet|after|once|when)\b/i.test(normalized)) return false;
  if (/\b(?:too much|too expensive|too high|instead|rather|counteroffer)\b/i.test(normalized)) return false;

  // Short affirmative replies are accepted only when the server also finds an
  // eligible offer immediately before this renter message.
  const shortAcceptance = /^(?:yes|yeah|yep|sure|okay|ok|please|perfect|great|deal|sounds good|that works|go ahead|i accept|i'll take it|that would help)(?: please| for me| thanks| thank you| do that)*$/;
  const affirmativePrefix = /^(?:yes|yeah|yep|sure|okay|ok)\s+/;
  const contextualAcceptance = normalized.replace(affirmativePrefix, "");
  if (shortAcceptance.test(normalized) ||
      (contextualAcceptance !== normalized && shortAcceptance.test(contextualAcceptance))) return true;

  const acceptedPrefix = /^(?:yes|yeah|yep|sure|okay|ok|please|go ahead|i accept|that works)\b/i.test(normalized);
  const explicitAction = /\b(?:apply|add|deduct|take|accept|use)\b/i.test(normalized);
  const refersToOffer = /\b(?:travel\s+(?:adjustment|discount|compensation|credit)|(?:adjustment|discount|compensation|credit)\b.{0,45}\b(?:offer|offered|agreed)|the\s+offer)\b/i.test(normalized);
  const affirmative = /\b(?:works(?:\s+for\s+me)?|sounds?\s+(?:good|fair)|is\s+(?:fine|okay|acceptable)|fine\s+by\s+me|deal|i\s+accept|i'll\s+take\s+it|that\s+would\s+help|go\s+ahead)\b/i.test(normalized);
  const directInstruction = /^(?:please\s+)?(?:apply|add|deduct|take)\b.{0,120}\b(?:travel\s+(?:adjustment|discount|compensation|credit)|(?:adjustment|discount|compensation|credit)\b.{0,45}\b(?:offer|offered|agreed)|the\s+offer)\b/i.test(normalized);
  const currencyAmount = /£\s*(\d+(?:\.\d{1,2})?)\s*(?:(?:one[- ]time)\s+)?(?:travel\s+)?(?:adjustment|discount|compensation|credit)\b|\b(?:travel\s+)?(?:adjustment|discount|compensation|credit)\b.{0,24}?£\s*(\d+(?:\.\d{1,2})?)/i.exec(normalized);
  const percentageAmount = /(\d+(?:\.\d+)?)\s*%\s*(?:(?:one[- ]time)\s+)?(?:travel\s+)?(?:adjustment|discount|compensation|credit)\b|\b(?:travel\s+)?(?:adjustment|discount|compensation|credit)\b.{0,24}?(\d+(?:\.\d+)?)\s*%/i.exec(normalized);
  const citedAmounts = [currencyAmount?.[1] ?? currencyAmount?.[2]]
    .filter((value): value is string => value !== undefined)
    .map(Number);
  const citedPercentages = [percentageAmount?.[1] ?? percentageAmount?.[2]]
    .filter((value): value is string => value !== undefined)
    .map(Number);
  const refersToCurrentOffer = refersToOffer || citedAmounts.length > 0 || citedPercentages.length > 0 ||
    /\b(?:it|this|that)\b/i.test(normalized);
  const amountMatchesOffer = expectedAmountGbp == null || (
    citedAmounts.every((amount) => Math.abs(amount - expectedAmountGbp) < 0.011) &&
    citedPercentages.every((percentage) => rentalChargeGbp != null &&
      Math.abs((percentage * rentalChargeGbp / 100) - expectedAmountGbp) < 0.011)
  );
  if (!amountMatchesOffer) return false;
  const explicitlyAccepts = (acceptedPrefix && explicitAction && refersToCurrentOffer) ||
    (affirmative && explicitAction && (refersToOffer || citedAmounts.length > 0 || citedPercentages.length > 0));
  return explicitlyAccepts || directInstruction;
}

function isTravelDiscountRequest(message: string): boolean {
  if (/\b(?:no|not|never|don't|do not|doesn't|does not|don't want|do not want)\b.{0,30}\b(?:discount|money off|price reduction|travel adjustment|compensation)\b/i.test(message)) return false;
  const asksForRelief = /\b(?:discount|off|price break|cheaper|reduce|lower|travel costs?|travel expenses?|travel adjustment|compensation|credit)\b/i.test(message);
  const requestLanguage = /\b(?:can|could|would|will|please|any chance|is it possible|offer|give|take|make it)\b/i.test(message) ||
    /\b(?:is|are)\s+there\s+(?:any\s+)?(?:help|support|assistance)\b/i.test(message);
  return asksForRelief && requestLanguage;
}

function isExplicitTravelDiscountRefusal(message: string): boolean {
  if (/\b(?:until|once|after|when|if|before)\b[^.!?]{0,70}\b(?:pickup|pick[ -]?up|collection|location|area|renter|you)\b/i.test(message)) return false;
  return /\b(?:can't|cannot|won't|unable to|not able to|not allowed to|fixed (?:price|rate)|no discounts?)\b[^.!?]{0,60}\b(?:offer|give|apply|take|reduce|lower|discount|off|travel|compensation|price)\b/i.test(message);
}

/** A location-gated discount request stays pending until it is offered or explicitly declined. */
export function hasPendingTravelDiscountRequest(history: TravelCompensationTurn[], lastRenterMessage: string): boolean {
  const turns = [...history];
  if (turns.at(-1)?.role !== "renter" || turns.at(-1)?.content !== lastRenterMessage) {
    turns.push({ role: "renter", content: lastRenterMessage });
  }
  let pending = false;
  for (const turn of turns) {
    if (turn.role === "renter" && isTravelDiscountRequest(turn.content)) pending = true;
    if (turn.role === "owner" && pending &&
        (isDiscountConcessionOffer(turn.content) || isExplicitTravelDiscountRefusal(turn.content))) pending = false;
  }
  return pending;
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
  // Pickup and return clock times are schedule questions. Without a place
  // request, they must not enter the location correction path just because
  // they contain the word "pickup" (for example, "is 11:00 pickup and 17:00
  // return possible?"). A named place or address question still counts.
  const mentionsPickupSchedule = /\b(?:pickup|pick[ -]?up|collection|collect|return|drop[ -]?off)\b/i.test(message);
  const containsExactClock = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b(?:1[0-2]|0?[1-9])\s?(?:am|pm)\b|\b\d{1,2}\s+o['’]?clock\b/i.test(message);
  const asksForPlace = /\b(?:where|which\s+(?:area|street|address|location)|what\s+(?:area|street|address|location)|address|postcode|street|meeting point|location|based|listed|listing)\b/i.test(message) ||
    /\b(?:in|from|near|around|outside|at)\s+(?!\d|(?:the\s+)?(?:morning|afternoon|evening|noon|midday|night)\b)[a-z][a-z'-]+/i.test(message);
  if (mentionsPickupSchedule && containsExactClock && !asksForPlace) return false;
  // A named neighborhood inside a travel complaint is context for the
  // distance, not automatically a pickup-location question. Requiring some
  // actual location/logistics language here prevents the pickup guard from
  // replacing a valid discount reply to "that's a long way from Shoreditch".
  // Mentioning a place as the origin of a long trip is context, not a second
  // pickup question. Only let a travel complaint enter the location path when
  // the renter actually asks about the pickup point or requests a different
  // handoff. A broad keyword check for "street" misclassified names such as
  // Northumberland Street and caused the guard to restart an already accepted
  // location disclosure.
  const asksExplicitLocation =
    /\b(?:where|which|what)\b[^.!?]{0,55}\b(?:pickup|pick[ -]?up|collection|collect|address|postcode|street|meeting point|location|area)\b/i.test(message) ||
    /\b(?:is|are|was|were|does|did)\b[^.!?]{0,65}\b(?:pickup|pick[ -]?up|collection|handoff|hand[ -]?over|address|postcode|street|meeting point|location|area)\b/i.test(message) ||
    /\b(?:can|could|would|may)\s+(?:i|we)\s+(?:collect|pick[ -]?up|meet|use|have)\b[^.!?]{0,65}\b(?:in|at|from|near|there|instead|listed|location|area|address)\b/i.test(message) ||
    /\b(?:tell|share|send|confirm|check|clarify)\b[^.!?]{0,45}\b(?:pickup|pick[ -]?up|collection|address|postcode|street|meeting point|location|area)\b/i.test(message) ||
    /\b(?:listing|ad)\b[^.!?]{0,65}\b(?:pickup|pick[ -]?up|collection|collect|address|postcode|meeting point|location|area)\b/i.test(message);
  if (isTravelConcern(message) && !asksExplicitLocation) return false;
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
  return /\b(?:where|which area|what area|exact|postcode|real|really|actually|correct|right|genuine|true|confirm|whether|listed|listing says)\b/i.test(message) ||
    /\b(?:tell|share|send)\s+(?:me|us)\s+(?:the\s+)?(?:(?:exact|full)\s+)?(?:pickup|pick[ -]?up|collection|meeting point|address|postcode|location|area)\b/i.test(message) ||
    /\b(?:which|what)\s+(?:pickup\s+)?(?:street|address)\b|\bstreet\s+address\b/i.test(message) ||
    /\b(?:i thought|i understood|i was told|i expected|i was expecting|the listing (?:says|shows|states)|the ad (?:says|shows)|it (?:says|shows))\b.{0,80}\b(?:pickup|pick[ -]?up|collection|at|in|near)\b/i.test(message) ||
    /\b(?:collect|pick[ -]?up|meet)\b.{0,35}\b(?:in|from|near)\s+(?!the\s+(?:morning|afternoon|evening)\b|morning\b|afternoon\b|evening\b)[a-z][a-z'-]+/i.test(message) ||
    /\b(?:is|are|was|does)\b.{0,40}\b(?:pickup|pick[ -]?up|collection|location|shoreditch|camden|trafalgar|northumberland|charing cross)\b/i.test(message) ||
    /\b(?:pickup|pick[ -]?up|collection|location)\b.{0,35}\b(?:in|at|near|from)\s+(?!(?:the\s+)?(?:morning|afternoon|evening|noon|midday|night)\b)[a-z][a-z'-]+/i.test(message);
}

/** Confirms that a reply discloses the expected account-specific pickup area. */
export function hasPickupAreaDisclosure(text: string, pickupArea: string | null | undefined): boolean {
  if (!pickupArea?.trim()) return false;
  return sentences(text).some((sentence) => {
    // The model often states the same policy as a direct question, e.g.
    // "Would collecting and returning in this area work for you?" Accept the
    // ordinary verb forms as well as the noun forms so the location guard
    // preserves the rest of a valid reply (including a capped offer).
    const namesPickup = /\b(?:collect(?:ion|ing)?|pickup|pick[ -]?up|handover|handoff)\b/i.test(sentence);
    const namesReturn = /\breturn(?:ing)?\b/i.test(sentence);
    return namesPickup && namesReturn && mentionsPickupArea(sentence, pickupArea);
  });
}

/** Detects the renter asking whether an advertised/previously named pickup area is valid. */
export function isPickupListingLocationQuestion(message: string): boolean {
  return /\b(?:listed|listing|the ad|it says|it shows|no way to get|usually|have (?:that|this) as a location)\b/i.test(message) ||
    /\b(?:so|then)\s+not\b/i.test(message);
}

/** The reply must say handoff cannot be arranged at the other location, without denying it exists. */
export function hasUnavailablePickupAlternative(text: string): boolean {
  return sentences(text).some((sentence) =>
    /\b(?:can(?:not|[’']t)|unable to|not able to|will not be able to|won[’']t be able to)\b.{0,60}\b(?:arrange|provide|offer)\b.{0,55}\b(?:handoff|hand[ -]?over|pickup|pick[ -]?up|collection|meeting)\b/i.test(sentence) ||
    /\b(?:handoff|hand[ -]?over|pickup|pick[ -]?up|collection|meeting)\b.{0,55}\b(?:can(?:not|[’']t)|unable to|not able to)\s+be\s+(?:arranged|provided|offered)\b/i.test(sentence) ||
    /\b(?:[a-z][a-z'-]*|the (?:listed|shown|other) location)\b.{0,35}\b(?:isn[’']t|is not)\b.{0,25}\b(?:available|an option)\b.{0,45}\b(?:for this rental|for this booking|for pickup|for collection|for handover)\b/i.test(sentence));
}

export function isTravelConcern(message: string): boolean {
  return /\b(?:travel(?:ing|ling|ed|led|s)?|journey|distance|trip|commute|route|too far|long way|far for me|far from me|far away|bit far|quite far|out of my way|inconvenient)\b/i.test(message);
}

export function isUnsafePickupLocationClaim(text: string): boolean {
  const deniesListedPickup = /\b(?:can(?:not|[’']t)|won(?:not|[’']t)|unable to|(?:am|is|are) not able to|(?:am|is|are)n[’']t able to)\b.{0,45}\b(?:arrange|provide|offer)\b.{0,45}\b(?:handoff|pickup|collection|meeting)\b.{0,70}\b(?:listed|advertised|shown)\s+(?:pickup\s+)?location\b/i.test(text);
  return /\b(?:fake|doesn['’]?t exist|does not exist|nonexistent|not a real location|isn['’]?t real|not real|only one (?:central )?(?:pickup|collection|location)|currently consolidat(?:ing|ed))\b/i.test(text) || deniesListedPickup;
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

/** The renter must accept the disclosed pickup area before travel compensation can be offered. */
export function hasPickupAreaAcceptance(
  history: TravelCompensationTurn[],
  lastRenterMessage: string,
  pickupArea: string | null | undefined,
): boolean {
  const turns = [...history];
  if (turns.at(-1)?.role !== "renter" || turns.at(-1)?.content !== lastRenterMessage) {
    turns.push({ role: "renter", content: lastRenterMessage });
  }
  let disclosure = -1;
  for (let index = 0; index < turns.length; index += 1) {
    if (turns[index].role === "owner" && mentionsPickupArea(turns[index].content, pickupArea)) disclosure = index;
  }
  if (disclosure < 0) return false;
  let accepted = false;
  for (const turn of turns.slice(disclosure + 1)) {
    if (turn.role !== "renter") continue;
    if (/\b(?:doesn['’]?t work|does not work|not (?:okay|ok|fine|comfortable|happy)|can['’]?t collect|cannot collect|won['’]?t work|too far to collect|can't make that location)\b/i.test(turn.content)) {
      accepted = false;
      continue;
    }
    const explicitAcceptance = mentionsPickupArea(turn.content, pickupArea) &&
      /\b(?:works?|fine|okay|ok|suits?|good|agree|happy with|comfortable with)\b/i.test(turn.content);
    // After the owner has named the pickup area, renters often accept it
    // anaphorically (“that area works for me”) without repeating the place
    // name. Keep this deliberately tied to an explicit area/location noun so
    // unrelated “that works” replies cannot authorize compensation.
    const referentialAcceptance =
      /\b(?:that|this|the)\s+(?:pickup\s+)?(?:area|location|place|meeting\s+point)\s+(?:works?|is\s+(?:fine|okay|ok|good)|suits?|is\s+acceptable)\b/i.test(turn.content) ||
      /\b(?:works?|is\s+(?:fine|okay|ok|good)|suits?)\s+for\s+me\b/i.test(turn.content) &&
        /\b(?:that|this|the)\s+(?:pickup\s+)?(?:area|location|place|meeting\s+point)\b/i.test(turn.content);
    const disclosedAreaQuestion =
      /\b(?:would|does|will|can)\b[^.!?]{0,120}\bwork(?:s|able)?\b/i.test(turns[disclosure].content) ||
      /\bif\b[^.!?]{0,120}\b(?:work|workable|suit)\b[^.!?]{0,45}\bfor\s+(?:you|your dates)\b/i.test(turns[disclosure].content);
    // Keep short yes/no replies bound to an owner message that explicitly
    // asked whether this disclosed pickup area works. The compensation
    // application path already accepts natural replies such as “Yes, that
    // works for me”; pickup state must interpret the same contextual answer.
    const bareAcceptance = /^\s*(?:(?:yes|yep|yeah|okay|ok|sure)[,\s]+)?(?:(?:that|this)\s+)?(?:works?(?:\s+for\s+me)?|is\s+(?:fine|okay|ok|good)(?:\s+for\s+me)?|suits?(?:\s+me)?|is\s+acceptable(?:\s+to\s+me)?)[.!?\s]*$/i.test(turn.content) &&
      disclosedAreaQuestion;
    if (explicitAcceptance || referentialAcceptance || bareAcceptance) accepted = true;
  }
  return accepted;
}

function explicitTravelObjection(message: string): boolean {
  const neutralCost = /\b(?:no|without|free|covered|waived)\b[^.!?]{0,35}\b(?:extra\s+|additional\s+)?(?:travel|journey|trip|commute|distance\s+)?(?:cost|expense|fare|charge)s?\b/i.test(message) ||
    /\b(?:travel|journey|trip|commute|distance)\b[^.!?]{0,55}\b(?:cost|expense|fare)s?\b[^.!?]{0,35}\b(?:not\s+(?:an?\s+)?(?:issue|problem|concern)|no\s+(?:issue|problem|concern)|fine|reasonable|acceptable|manageable)\b/i.test(message);
  if (neutralCost) return false;
  const explicitPattern = /\b(?:too\s+far|long\s+(?:way|journey|trip|drive)|(?:bit|quite|a little)\s+far|far\s+(?:for me|from me|away)|distance\s+(?:is\s+)?(?:too much|too far|an issue|a problem|long)|(?:too much|a lot of)\s+travel|travel\s+(?:costs?|expenses?|is\s+(?:too much|expensive|far)|feels\s+(?:too much|expensive))|extra\s+travel|hard\s+to\s+get\s+to|inconvenient|doesn'?t\s+work\s+for\s+me|out\s+of\s+my\s+way|pickup.{0,20}\b(?:too far|far|a long way)\b)\b/i.test(message);
  if (explicitPattern) return true;
  // Renters often explain the impact in their own words rather than saying
  // “too far”: recognize a disclosed trip that adds money or expense, while
  // requiring both an explicit cost and a burden signal.
  const travel = /\b(?:travel(?:ling|ing)?|journey|trip|commute|distance|route)\b/i.test(message);
  const cost = /\b(?:costs?|expense|expenses|fare|price|money|expensive|costly|pricey)\b/i.test(message);
  const burden = /\b(?:adds?|means?|costs?\s+(?:me|us)|would\s+cost|will\s+cost|extra|additional|more|high|too\s+much|quite\s+a\s+bit|a\s+lot|expensive|costly|pricey|for\s+me|for\s+us)\b/i.test(message);
  return travel && cost && burden;
}

export function assessTravelCompensation(input: {
  history: TravelCompensationTurn[];
  lastRenterMessage: string;
  pickupArea?: string | null;
  rentalChargeGbp?: number | null;
}): TravelCompensationAssessment {
  const pickupAreaDisclosed = disclosedArea(input.history, input.pickupArea);
  const pickupAreaAccepted = hasPickupAreaAcceptance(input.history, input.lastRenterMessage, input.pickupArea);
  const renterObjected = explicitTravelObjection(input.lastRenterMessage);
  const alreadyOffered = input.history.some((turn, index) =>
    turn.role === "owner" && isDiscountConcessionOffer(turn.content) &&
    (isTravelCompensationOffer(turn.content) || input.history.slice(0, index).some((prior) =>
      prior.role === "renter" && (isTravelConcern(prior.content) || isPickupLocationIntent(prior.content)),
    )),
  );
  const maximumGbp = travelCompensationMaximum(input.rentalChargeGbp);
  return {
    // The renter may object before accepting the area. That objection is the
    // point at which the one-time travel offer can help recover the request;
    // acceptance remains a separate requirement before booking proceeds.
    eligible: pickupAreaDisclosed && renterObjected && !alreadyOffered && maximumGbp != null,
    pickupAreaDisclosed,
    pickupAreaAccepted,
    renterObjected,
    alreadyOffered,
    maximumGbp,
  };
}

export function replaceTravelCompensationOffers(text: string, maximumGbp: number): string {
  const amount = `£${maximumGbp.toFixed(2)}`;
  return sentences(text)
    .map((sentence) => {
      if (!isPositiveDiscountSentence(sentence)) return sentence;
      // Keep a condition that asks the renter to accept the disclosed
      // collection area. Replacing the whole model sentence used to erase
      // that decision point along with the unsafe amount.
      const locationCondition = sentence.match(
        /\bif\b[^.!?]{0,120}\b(?:pickup|pick[ -]?up|collect(?:ion|ing)?|return(?:ing)?|area|location|handoff|hand[ -]?over)\b[^.!?]{0,90}\b(?:works?|okay|fine|suits?|agree)\b[^.!?]*/i,
      )?.[0]?.trim();
      return `I can offer a one-time ${amount} travel adjustment on this rental${locationCondition ? ` ${locationCondition}` : "."}`;
    })
    .join(" ")
    .trim();
}

/** Exclude only the exact adjustment that the policy gate has already authorized
 * from ordinary price validation. Other prices in the reply remain checked. */
export function withoutAuthorizedTravelCompensationClaim(text:string,maximumGbp:number|null,authorized:boolean):string {
  if(!authorized||maximumGbp==null)return text;
  // Guarded offer sentences can include a polite suffix such as "if you'd
  // like". Match the verified concession itself, not sentence punctuation.
  const canonical=`I can offer a one-time £${maximumGbp.toFixed(2)} travel adjustment on this rental`;
  const escaped=canonical.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  return text.replace(new RegExp(escaped,"gi"),"");
}

export function stripTravelCompensationOffers(text: string): string {
  return sentences(text)
    .filter((sentence) => !isPositiveDiscountSentence(sentence))
    .join(" ")
    .trim();
}

/** Remove only the discount conversation while preserving unrelated grounded answers. */
export function stripPrematureDiscountDiscussion(text: string): string {
  const discussesDiscount = (sentence: string) =>
    isPositiveDiscountSentence(sentence) ||
    /\b(?:discount|price break|cheaper|reduce\s+(?:the\s+)?(?:price|rate)|lower\s+(?:the\s+)?(?:price|rate)|take\b.{0,28}\boff\b|travel.{0,24}(?:cost|adjustment|compensation|credit)|compensation|credit)\b/i.test(sentence);
  const removeDiscountClauses = (sentence: string): string => {
    if (!discussesDiscount(sentence)) return sentence;

    // A model can put an unauthorized discount statement and the required
    // pickup-area question in the same sentence. Strip the discount clause,
    // while keeping the independent answer/request that follows it.
    const clauses = sentence
      .split(/(?:[,;]\s*|\s+)(?:but|however|although|though|and)\s+/i)
      .map((clause) => clause.trim())
      .filter((clause) => clause && !discussesDiscount(clause));

    return clauses.join(" ").replace(/^[a-z]/, (letter) => letter.toUpperCase());
  };

  return sentences(text).map(removeDiscountClauses).filter(Boolean).join(" ").trim();
}
