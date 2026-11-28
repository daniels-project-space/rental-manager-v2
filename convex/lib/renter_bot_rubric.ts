import {nativeInformationForText} from "./native_information_blocks";
import type {BudgetPriceCheck} from "./budget_price_check";
import {type ReplacementValueComparison} from "./replacement_value_comparison";
import type {OwnerCheck} from "./owner_checks";
import {unsupportedPriceClaims,type PriceEvidence} from "./price_claims";
import { assessIncludedKitAnswer, type KitEvidence } from "./kit_claims";
import type {StockRequest} from "./stock_claims";
import type { BookingRecord } from "./booking_record";
import { hasPickupDisclosure } from "./booking_reply_claims";
import {
  assessTravelCompensation,
  discountConcessionExceedsCap,
  hasPendingTravelDiscountRequest,
  hasPickupAreaDisclosure,
  hasUnavailablePickupAlternative,
  isPickupListingLocationQuestion,
  isDiscountConcessionOffer,
  isPickupLocationIntent,
  isTravelCompensationOffer,
  isTravelConcern,
  isUnsafePickupLocationClaim,
  mentionsPickupArea,
  verifiedRentalChargeGbp,
  withoutAuthorizedTravelCompensationClaim,
  type TravelCompensationTurn,
} from "./travel_compensation";
/**
 * renter_bot_rubric — scores one renter-bot draft against Daniel's policy
 * categories, for the test harness only (never imported by production
 * draft-generation code). Combines:
 *   - the REAL production filters (renter_bot_filters.ts)
 *   - the supplemental test-only filters (gap coverage vs V1)
 *   - the ported tone scorers
 *   - a lightweight factsClaimed grounding check
 *
 * Categories with no automated signal are scored "unassessed"; "n_a" is
 * reserved for checks that genuinely do not apply to this turn. A run with
 * unassessed categories cannot receive an overall pass.
 */
import { applyRenterBotFilters } from "./renter_bot_filters";
import {
  applySupplementalFilters,
  type FactClaim,
} from "./renter_bot_filters_supplemental";
import { scoreTone } from "./renter_bot_tone_scorer";
import { containsCrossAccountReference } from "./cross_account_references";

export interface ProductionFlag {
  type: string;
  action: string;
  detail: string;
  severity: string;
}

export interface RubricInput {
  accountSlug: string;
  draftText: string;
  factsClaimed?: FactClaim[];
  // The REAL guardDraft() (convex/lib/draft_guard.ts) output for this draft,
  // from generateDraft's own return value. Added 2026-08-17 after finding
  // this harness's own checks (below) were validated against
  // renter_bot_filters.ts -- which has ZERO callers anywhere in the
  // production codebase. That file is dead code. draft_guard.ts is what
  // actually runs. When present, these real flags are surfaced directly
  // (see "production_guard:*" categories) rather than only relying on this
  // file's own regex reimplementations, which don't necessarily match what
  // guardDraft actually checks for (confirmed different: e.g. guardDraft's
  // UPSELL_PATTERNS are stage-gated and narrower than this file's
  // UPSELL_LANGUAGE list).
  productionFlags?: ProductionFlag[];
  /** Native generation evidence, separate from the model's self-report. */
  priceEvidence?: PriceEvidence[];
  verifiedDeliveryFeeGbp?: number | null;
  priceRequest?: StockRequest;
  lastRenterMessage?: string;
  conversationHistory?: TravelCompensationTurn[];
  pickupArea?: string | null;
  /** Current owner-verified, listing-scoped explanation for a pickup-area mismatch. */
  pickupReason?: string | null;
  pickupAddress?: string | null;
  pickupPrivacySources?: string[];
  pickupConfirmed?: boolean;
  rentalChargeGbp?: number | null;
  rentalStage?: string | null;
  bookingRecord?: BookingRecord;
  replacementValueComparisons?:ReplacementValueComparison[];
  budgetPriceChecks?:BudgetPriceCheck[];
  /** Persisted Native review tasks for this exact generated draft/context. */
  pendingOwnerChecks?: OwnerCheck[];
  /** Source-backed manifest for the single selected item, when available. */
  kitEvidence?: KitEvidence[];
  /** A validated transaction confirmation assembled server-side without a model draft. */
  serverVerifiedAction?: boolean;
}

export type RubricStatus = "pass" | "fail" | "flag" | "n_a" | "unassessed";

export interface RubricCategoryResult {
  category: string;
  status: RubricStatus;
  detail: string;
  evidence?: string;
}

export interface RubricOutput {
  results: RubricCategoryResult[];
  overall_status: "pass" | "fail" | "flag" | "incomplete";
  filter_violation_categories: string[];
}

const TONE_PASS_THRESHOLD = 0.6;

const GEAR_KNOWLEDGE_INTENT = /\b(?:spec(?:ification)?s?|accessor(?:y|ies)|what(?:'s| is) included|(?:this |that |the )?(?:kit|package|bundle) includ(?:e|es|ed|ing)|comes with|autofocus|auto-focus|manual focus|lens mount|mount type|adapter|battery|batteries|memory card|sd card|cf\s*express|ssd|storage|codec|record(?:ing)?|resolution|sensor|frame rate|fps|weight|compatib(?:le|ility)|aperture|filter|built.?in nd|dual native iso)\b/i;
const NEGOTIATION_INTENT = /\b(?:discount|take (?:£\s*\d+|\d+\s*%)?\s*off|reduce|lower (?:the )?price|cheaper|better price|price match|can you do|deal|too expensive|travel cost|compensation|concession|budget)\b/i;
const PROBLEM_SOLVING_INTENT = /\b(?:problem|issue|broken|damaged|wrong|can't|cannot|unable|cancel(?:lation)?|failed verification|verification failed|unavailable|out of stock|missing|refund|complaint|repair)\b/i;
const FOLLOW_UP_INTENT = /\b(?:follow[ -]?up|remind(?:er)?|24 hours|tomorrow|check back|get back to you|send you an update|message you later)\b/i;

function relevantToGearKnowledge(input: RubricInput) {
  return GEAR_KNOWLEDGE_INTENT.test(input.lastRenterMessage ?? "") ||
    GEAR_KNOWLEDGE_INTENT.test(input.draftText) ||
    (input.factsClaimed ?? []).some(fact => /spec|accessor|compatib|technical|equipment/i.test(fact.kind));
}

function relevantToNegotiation(input: RubricInput) {
  const renterMessage = input.lastRenterMessage ?? "";
  const message = renterMessage.replace(
    /\b(?:travel|journey|distance|trip)\b[^.!?]{0,45}\b(?:costs?|expenses?|discounts?|adjustments?|compensation|credits?)\b|\b(?:discounts?|adjustments?|compensation|credits?)\b[^.!?]{0,45}\b(?:travel|journey|distance|trip)\b/gi,
    "",
  );
  const travelOnlyReliefRequest = hasPendingTravelDiscountRequest(input.conversationHistory ?? [], renterMessage) &&
    isTravelConcern(renterMessage) &&
    !/\b(?:rental|hire|item|kit|basket|booking|total|price|rate)\b/i.test(renterMessage);
  if (travelOnlyReliefRequest) return false;
  const nonTravelDiscountOffer = input.draftText.split(/(?<=[.!?])\s+/).some(sentence =>
    isDiscountConcessionOffer(sentence) && !isTravelCompensationOffer(sentence),
  );
  return NEGOTIATION_INTENT.test(message) || nonTravelDiscountOffer;
}

function relevantToProblemSolving(input: RubricInput) {
  return PROBLEM_SOLVING_INTENT.test(input.lastRenterMessage ?? "");
}

function relevantToFollowUp(input: RubricInput) {
  return FOLLOW_UP_INTENT.test(`${input.lastRenterMessage ?? ""} ${input.draftText}`);
}

/** A withheld answer is not automatically a successful safety escalation. */
export function scoreSkippedGeneration(reason: string | undefined, expectedEscalation: boolean): RubricOutput {
  const policyEscalation = expectedEscalation && reason?.startsWith("needs_human:") === true;
  const status = policyEscalation ? "pass" : "fail";
  return {
    overall_status: status,
    filter_violation_categories: policyEscalation ? [] : ["GENERATION_FAILED"],
    results: [{ category: "generation_outcome", status, detail: policyEscalation
      ? `Expected human review: ${reason}`
      : `No reply was generated. This is not a passing answer: ${reason ?? "no diagnostic reason"}` }],
  };
}

function has(categories: Set<string>, ...names: string[]): boolean {
  return names.some((n) => categories.has(n));
}

function evidenceFor(
  violations: { category: string; matchedText?: string }[],
  ...names: string[]
): string | undefined {
  const hit = violations.find((v) => names.includes(v.category));
  return hit?.matchedText;
}

export function scoreDraft(input: RubricInput): RubricOutput {
  const { accountSlug, draftText, factsClaimed = [] } = input;

  const real = applyRenterBotFilters(draftText);
  const supplemental = applySupplementalFilters(
    draftText,
    accountSlug,
    factsClaimed,
  );
  const latestRenterMessage = input.lastRenterMessage ?? "";
  const history = input.conversationHistory ?? [];
  const compensationHistory = history.length && history[history.length - 1]?.role === "renter" && history[history.length - 1]?.content === latestRenterMessage
    ? history
    : latestRenterMessage ? [...history, { role: "renter" as const, content: latestRenterMessage }] : history;
  const effectiveRentalChargeGbp = verifiedRentalChargeGbp({
    rentalChargeGbp: input.rentalChargeGbp,
    priceEvidence: input.priceEvidence,
    priceRequest: input.priceRequest,
  });
  const travelAssessment = assessTravelCompensation({
    history: compensationHistory,
    lastRenterMessage: latestRenterMessage,
    pickupArea: input.pickupArea,
    rentalChargeGbp: effectiveRentalChargeGbp,
  });
  const authorizedTravelOffer=travelAssessment.eligible&&isDiscountConcessionOffer(draftText)&&
    !discountConcessionExceedsCap(draftText,effectiveRentalChargeGbp,travelAssessment.maximumGbp);
  const priceValidationText=withoutAuthorizedTravelCompensationClaim(draftText,travelAssessment.maximumGbp,authorizedTravelOffer);
  const nativePricing=input.priceEvidence!==undefined&&input.priceRequest!==undefined;
  const nativePriceFailures=nativePricing?unsupportedPriceClaims(nativeInformationForText({replacement_value_comparisons:input.replacementValueComparisons,budget_price_checks:input.budgetPriceChecks},priceValidationText,priceValidationText).claim_text,input.priceEvidence!,input.priceRequest!,input.lastRenterMessage??"",input.bookingRecord,input.verifiedDeliveryFeeGbp):[];
  const asksForUpdatedTotal = /\b(?:new|updated|revised|combined)\s+(?:rental\s+)?total\b/i.test(latestRenterMessage);
  const includesExplicitTotal = /\btotal\b[^.!?\n]{0,36}£\s?\d+(?:\.\d{1,2})?|£\s?\d+(?:\.\d{1,2})?[^.!?\n]{0,36}\btotal\b/i.test(draftText);
  const omittedVerifiedUpdatedTotal = nativePricing && asksForUpdatedTotal && effectiveRentalChargeGbp != null && !includesExplicitTotal;
  const allViolations = [...real.violations, ...supplemental.filter(v=>!nativePricing||!["MADE_UP_PRICE","UNVERIFIABLE_PRICE"].includes(v.category))];
  const cats = new Set(allViolations.map((v) => v.category));
  if (containsCrossAccountReference(draftText)) cats.add("CROSS_ACCOUNT_REFERENCE");
  if(nativePriceFailures.length)cats.add("NATIVE_PRICE_UNSUPPORTED");
  const verificationFailed = input.rentalStage === "VERIFICATION_FAILED";
  const compensationContext = verificationFailed || isPickupLocationIntent(latestRenterMessage) ||
    isTravelConcern(latestRenterMessage) || isTravelCompensationOffer(draftText);
  const discountOfferPresent = isDiscountConcessionOffer(draftText);
  const travelDiscountRequestPending = hasPendingTravelDiscountRequest(compensationHistory, latestRenterMessage);
  const discountPolicyViolation = discountOfferPresent && (verificationFailed ||
    (compensationContext && (!travelAssessment.eligible || discountConcessionExceedsCap(draftText, effectiveRentalChargeGbp, travelAssessment.maximumGbp))));
  const authorizedTravelRequestIgnored = travelAssessment.eligible && travelDiscountRequestPending && !discountOfferPresent;
  const pickupQuestion = isPickupLocationIntent(latestRenterMessage);
  const pickupPrivacySources = input.pickupPrivacySources?.length
    ? input.pickupPrivacySources
    : input.pickupAddress ? [input.pickupAddress] : [];
  const renterDeliveryMessages = [...(input.conversationHistory ?? []).filter(turn => turn.role === "renter").map(turn => turn.content), latestRenterMessage];
  const pickupPrivacyLeak = !input.pickupConfirmed && hasPickupDisclosure(draftText, pickupPrivacySources,input.pickupArea,renterDeliveryMessages);
  const wrongPickupArea = !verificationFailed && pickupQuestion && !!input.pickupArea && !mentionsPickupArea(draftText, input.pickupArea);
  const missingPickupAreaDisclosure = !verificationFailed && pickupQuestion && !!input.pickupArea &&
    !input.pickupConfirmed && !hasPickupAreaDisclosure(draftText, input.pickupArea);
  const missingListedLocationBoundary = !verificationFailed && pickupQuestion &&
    isPickupListingLocationQuestion(latestRenterMessage) && !hasUnavailablePickupAlternative(draftText);
  const missingConfirmedPickup = !verificationFailed && pickupQuestion && !!input.pickupConfirmed && !!input.pickupAddress &&
    !draftText.toLowerCase().includes(input.pickupAddress.toLowerCase());
  const unsafePickupClaim = isUnsafePickupLocationClaim(draftText);

  const results: RubricCategoryResult[] = [];
  const add = (
    category: string,
    status: RubricStatus,
    detail: string,
    evidence?: string,
  ) => results.push({ category, status, detail, evidence });

  // ── Disclosure / confidentiality ──
  if (
    has(
      cats,
      "PLATFORM_LEAK",
      "INTERNAL_PRICING_DISCLOSURE",
      "TIMESTAMP",
      "INTERNAL_ACTION",
      "CHAIN_OF_THOUGHT",
    )
  ) {
    add(
      "disclosure",
      "fail",
      "Draft leaked platform identity, internal pricing, timestamps, an internal action note, or raw reasoning.",
      evidenceFor(
        allViolations,
        "PLATFORM_LEAK",
        "INTERNAL_PRICING_DISCLOSURE",
        "TIMESTAMP",
        "INTERNAL_ACTION",
        "CHAIN_OF_THOUGHT",
      ),
    );
  } else {
    add("disclosure", "pass", "No disclosure-filter violations detected.");
  }

  // ── Upsell (known policy/filter disagreement — see policy doc) ──
  if (has(cats, "UPSELL_LANGUAGE")) {
    add(
      "upsell",
      "flag",
      'Upsell language was stripped by the real filter. Confirmed policy/filter mismatch: DB-seeded rules allow upsell "when interested," the regex filter blocks unconditionally — needs a real fixture to characterize before treating either as ground truth.',
      evidenceFor(allViolations, "UPSELL_LANGUAGE"),
    );
  } else {
    add("upsell", "pass", "No upsell-language filter hit.");
  }

  // ── Gear knowledge ──
  const includedKitAnswer = assessIncludedKitAnswer(input.lastRenterMessage ?? "", input.draftText, input.kitEvidence ?? []);
  if (includedKitAnswer) {
    add("gear_knowledge", includedKitAnswer.status, includedKitAnswer.detail, includedKitAnswer.evidence);
  } else {
    add("gear_knowledge", relevantToGearKnowledge(input) ? "unassessed" : "n_a",
      relevantToGearKnowledge(input)
        ? "This turn asks for or asserts a gear specification; the production filters do not verify every specification or whether the reply fully answers the requirement."
        : "No technical specification or included-accessory claim is in scope for this turn.");
  }

  // ── Pricing / quoting ──
  if (omittedVerifiedUpdatedTotal) {
    add(
      "pricing_quoting",
      "fail",
      `The renter explicitly requested the updated total, and a verified current basket total of £${effectiveRentalChargeGbp!.toFixed(2)} was available, but the draft did not state a total.`,
    );
  } else if(nativePricing&&!has(cats,"FABRICATED_QUOTE")) {
    const travelOfferAudit = isTravelCompensationOffer(draftText)
      ? ` Travel-offer trace: explicit charge ${input.rentalChargeGbp == null ? "none" : `£${input.rentalChargeGbp.toFixed(2)}`}; resolved rental charge ${effectiveRentalChargeGbp == null ? "unknown" : `£${effectiveRentalChargeGbp.toFixed(2)}`}; allowed maximum ${travelAssessment.maximumGbp == null ? "unknown" : `£${travelAssessment.maximumGbp.toFixed(2)}`}; sequence eligible ${travelAssessment.eligible}; offer authorized ${authorizedTravelOffer}; travel offer remains in price-validation text ${isTravelCompensationOffer(priceValidationText)}.`
      : "";
    add("pricing_quoting",nativePriceFailures.length?"fail":"pass",nativePriceFailures.length
      ? "The quoted amounts do not have matching Native item, quantity and date proof." + travelOfferAudit
      : "No monetary claim lacks matching Native price proof.",nativePriceFailures.join("; ")||undefined);
  } else if (has(cats, "MADE_UP_PRICE", "FABRICATED_QUOTE")) {
    add(
      "pricing_quoting",
      "fail",
      "Draft stated a price or quote that contradicts a real, non-empty fact-check pass — confident signal.",
      evidenceFor(allViolations, "MADE_UP_PRICE", "FABRICATED_QUOTE"),
    );
  } else if (has(cats, "UNVERIFIABLE_PRICE")) {
    add(
      "pricing_quoting",
      "flag",
      "Draft stated a price but this run returned no fact-check data at all (expected on the fallback generation path) — can't confirm or refute, worth a manual look rather than a confirmed violation.",
      evidenceFor(allViolations, "UNVERIFIABLE_PRICE"),
    );
  } else {
    add("pricing_quoting", "pass", "All prices/quotes trace to a verified fact, or none were made.");
  }

  // ── Negotiation ──
  add("negotiation", relevantToNegotiation(input) ? "unassessed" : "n_a",
    relevantToNegotiation(input)
      ? "A price concession or negotiation request is present; the full conversation stance still needs trajectory-level assessment."
      : "This turn contains no bargaining or price concession to assess.");

  // ── Travel compensation sequence ──
  if (discountPolicyViolation) {
    add(
      "discounts_retention",
      "fail",
      "Travel compensation was offered before this account's pickup area was disclosed and objected to, after a prior offer, without a verified rental total, or above the one-time cap.",
      draftText,
    );
  } else if (authorizedTravelRequestIgnored) {
    add(
      "discounts_retention",
      "fail",
      `The renter asked for travel-cost help after this account's pickup area was disclosed; the verified one-time adjustment of £${travelAssessment.maximumGbp!.toFixed(2)} was eligible but not offered.`,
    );
  } else if (compensationContext) {
    add(
      "discounts_retention",
      "pass",
      "No premature, repeated, unpriced, or over-cap travel compensation offer was detected.",
    );
  } else {
    add(
      "discounts_retention",
      "n_a",
      "This turn does not concern pickup distance or travel compensation.",
    );
  }

  // ── Follow-up texting ──
  add("follow_up_texting", relevantToFollowUp(input) ? "unassessed" : "n_a",
    relevantToFollowUp(input)
      ? "This turn mentions a follow-up or reminder; timing and draft eligibility are checked by the Lab follow-up workflow, not this reply rubric."
      : "No follow-up or reminder is requested or promised in this reply; delayed follow-ups are assessed by the Lab workflow.");

  // ── Cross-account consistency ──
  if (has(cats, "DUAL_ACCOUNT", "CROSS_ACCOUNT_REFERENCE")) {
    add(
      "cross_account_consistency",
      "fail",
      "Draft implied a link between this account and another account's persona.",
      evidenceFor(allViolations, "DUAL_ACCOUNT", "CROSS_ACCOUNT_REFERENCE") ??
        (containsCrossAccountReference(draftText) ? draftText : undefined),
    );
  } else {
    add("cross_account_consistency", "pass", "No cross-account leak detected.");
  }

  // ── Account-specific pickup handling ──
  if (unsafePickupClaim || pickupPrivacyLeak || wrongPickupArea || missingPickupAreaDisclosure || missingListedLocationBoundary || missingConfirmedPickup ||
    has(cats, "VAGUE_CONFIRMED_LOCATION", "PREMATURE_CONFIRMATION")) {
    add(
      "location_handling",
      "fail",
      "Draft made an unsupported location claim, omitted the account-specific pickup/return area or listed-location boundary, used the wrong area, disclosed exact details too early, or omitted the confirmed meeting point.",
      [
        unsafePickupClaim ? "unsupported location excuse" : null,
        pickupPrivacyLeak ? "exact pickup detail disclosed before confirmation" : null,
        wrongPickupArea ? "expected account area: " + input.pickupArea : null,
        missingPickupAreaDisclosure ? "missing account-specific pickup/return arrangement for this rental" : null,
        missingListedLocationBoundary ? "did not explain that handoff from the listed pickup area cannot be arranged for this rental" : null,
        missingConfirmedPickup ? "confirmed booking missing its exact meeting point" : null,
        evidenceFor(allViolations, "VAGUE_CONFIRMED_LOCATION", "PREMATURE_CONFIRMATION"),
      ].filter(Boolean).join("; ") || undefined,
    );
  } else if (!verificationFailed && pickupQuestion && !input.pickupArea) {
    add(
      "location_handling",
      "flag",
      "The renter asked about pickup, but this test had no owner-confirmed account area to verify the answer against.",
    );
  } else if (has(cats, "LOCATION_PLACEHOLDER")) {
    add(
      "location_handling",
      "flag",
      "Draft contains what looks like an unfilled location template artifact.",
      evidenceFor(allViolations, "LOCATION_PLACEHOLDER"),
    );
  } else {
    add("location_handling", "pass", "No location-handling violations detected.");
  }

  // ── Anti-manipulation / rule adherence ──
  if (has(cats, "PHYSICAL_PRESENCE", "FALSE_ACTION_CLAIM", "INVALID_TIME_ACCEPTED")) {
    add(
      "anti_manipulation_rule_adherence",
      "fail",
      "Draft implied physical presence, claimed an action it can't perform, or accepted a time outside working hours.",
      evidenceFor(allViolations, "PHYSICAL_PRESENCE", "FALSE_ACTION_CLAIM", "INVALID_TIME_ACCEPTED"),
    );
  } else {
    add("anti_manipulation_rule_adherence", "pass", "No manipulation/rule-adherence violations detected.");
  }

  add("owner_review_completion",input.pendingOwnerChecks===undefined?(input.serverVerifiedAction?"n_a":"unassessed"):input.pendingOwnerChecks.length?"flag":"pass",
    input.pendingOwnerChecks===undefined?(input.serverVerifiedAction?"A receipt-backed Lab transaction confirmation makes no new owner-dependent claims.":"Persisted owner-review state was not supplied; completion is unverified."):input.pendingOwnerChecks.length
      ?"Native owner-review work remains pending. A safe deferral does not complete the renter request."
      :"No pending Native owner-review task is attached to this draft; this alone does not prove the whole request is fulfilled.",
    input.pendingOwnerChecks?.map(check=>`${check.kind}: ${check.source_call_id}`).join("; ")||undefined);

  // ── Problem solving ──
  add("problem_solving", relevantToProblemSolving(input) ? "unassessed" : "n_a",
    relevantToProblemSolving(input)
      ? "The renter reports an obstacle or asks for recovery; its resolution needs trajectory-level assessment."
      : "No complaint, failure, damage, cancellation, or unavailable-item recovery is in scope for this turn.");

  // ── Tone / language ──
  if (input.serverVerifiedAction) {
    add("tone_language", "n_a", "This confirmation was constructed from a validated transaction receipt; model-generated account-tone scoring does not apply.");
  } else {
    const tone = scoreTone(accountSlug, draftText);
    if (tone.score === null) {
      add("tone_language", "unassessed", tone.reason ?? "No tone score available.");
    } else if (tone.score >= TONE_PASS_THRESHOLD) {
      add("tone_language", "pass", `Tone score ${tone.score.toFixed(2)} (threshold ${TONE_PASS_THRESHOLD}).`);
    } else {
      add("tone_language", "flag", `Tone score ${tone.score.toFixed(2)} below threshold ${TONE_PASS_THRESHOLD} — review manually.`);
    }
  }

  // ── Format integrity (not one of Daniel's named categories, kept as a
  // catch-all so a broken/empty/oversized draft doesn't silently pass) ──
  if (has(cats, "EMPTY_RESPONSE")) {
    add("format_integrity", "fail", "Draft was empty.");
  } else if (has(cats, "FORMAT_ARTIFACT")) {
    add(
      "format_integrity",
      "flag",
      "Raw markdown/JSON structure appears to have leaked into renter-visible text.",
      evidenceFor(allViolations, "FORMAT_ARTIFACT"),
    );
  } else if (has(cats, "TOO_LONG")) {
    add("format_integrity", "flag", "Draft is unusually long for a texting-style reply.", evidenceFor(allViolations, "TOO_LONG"));
  } else {
    add("format_integrity", "pass", "Draft is non-empty, reasonably sized, no format leakage detected.");
  }

  // ── Real production guard flags (draft_guard.ts, via generateDraft's own
  // return value) — the actual safety net, surfaced directly rather than
  // only through this file's own regex reimplementations above. ──
  const productionFlags = input.productionFlags ?? [];
  const identityFailures = productionFlags.filter(flag => flag.type === "RENTER_CAMERA_IDENTITY_UNVERIFIED" && flag.action === "flagged");
  add("renter_camera_identity",input.productionFlags===undefined?(input.serverVerifiedAction?"n_a":"unassessed"):identityFailures.length?"fail":"pass",
    input.productionFlags===undefined?(input.serverVerifiedAction?"The receipt-backed action confirmation makes no renter-camera identity claim.":"Native camera-reference check was not supplied."):identityFailures.length
      ?"The reply assumes a renter camera identity without explicit setup evidence."
      :"No unsupported labelled renter-camera reference was detected; this does not verify camera controls or all technical advice.",
    identityFailures.map(flag=>flag.detail).join("; ")||undefined);
  if (input.productionFlags === undefined) {
    add(
      "production_guard",
      input.serverVerifiedAction ? "n_a" : "unassessed",
      input.serverVerifiedAction
        ? "This confirmation is constructed from the validated Lab transaction receipt; there is no model-generated draft to guard."
        : "No productionFlags passed in for this run — caller didn't forward generateDraft's real guard output.",
    );
  } else if(productionFlags.length===0) {
    add("production_guard","pass","Production guard output was supplied and contains no flags.");
  } else {
    for (const f of productionFlags) {
      // action="flagged" means guardDraft detected the issue but left the text
      // alone (ReplyInbox.tsx shows these as "⚠ to review" for Daniel to catch
      // manually before sending) — the delivered draft may still contain it, so
      // severe ones are real rubric failures. action="stripped"/"rewritten"
      // means the guard already corrected the text before it could be
      // delivered — still worth surfacing as a raw-model-quality signal, but
      // it isn't a defect in the actual delivered draft, so cap it at "flag".
      const corrected = f.action === "stripped" || f.action === "rewritten";
      const status: RubricStatus = corrected
        ? f.severity === "critical" || f.severity === "high"
          ? "flag"
          : "pass"
        : f.severity === "critical" || f.severity === "high"
          ? "fail"
          : "flag";
      add(
        `production_guard:${f.type}`,
        status,
        `[REAL guardDraft flag, action=${f.action}, severity=${f.severity}, ${corrected ? "auto-corrected before delivery" : "UNRESOLVED — relies on Daniel catching it manually"}] ${f.detail}`,
      );
    }
  }

  const overall_status: RubricOutput["overall_status"] = results.some(
    (r) => r.status === "fail",
  )
    ? "fail"
    : results.some((r) => r.status === "flag")
      ? "flag"
      : results.some((r) => r.status === "unassessed")
        ? "incomplete"
        : "pass";

  return {
    results,
    overall_status,
    filter_violation_categories: [...cats],
  };
}
