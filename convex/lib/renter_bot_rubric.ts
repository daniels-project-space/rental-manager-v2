/**
 * renter_bot_rubric — scores one renter-bot draft against Daniel's policy
 * categories, for the test harness only (never imported by production
 * draft-generation code). Combines:
 *   - the REAL production filters (renter_bot_filters.ts)
 *   - the supplemental test-only filters (gap coverage vs V1)
 *   - the ported tone scorers
 *   - a lightweight factsClaimed grounding check
 *
 * Categories with no automated signal today are scored "n_a" with an
 * explanation, rather than faked — see docs/renter-bot-policy.md for the
 * open questions this maps to (negotiation quality, follow-up texting,
 * gear-knowledge accuracy, problem-solving quality all need either a human
 * pass or a separate LLM-judge call; out of scope for this first version).
 */
import { applyRenterBotFilters } from "./renter_bot_filters";
import {
  applySupplementalFilters,
  type FactClaim,
} from "./renter_bot_filters_supplemental";
import { scoreTone } from "./renter_bot_tone_scorer";

export interface RubricInput {
  accountSlug: string;
  draftText: string;
  factsClaimed?: FactClaim[];
}

export type RubricStatus = "pass" | "fail" | "flag" | "n_a";

export interface RubricCategoryResult {
  category: string;
  status: RubricStatus;
  detail: string;
  evidence?: string;
}

export interface RubricOutput {
  results: RubricCategoryResult[];
  overall_status: "pass" | "fail" | "flag";
  filter_violation_categories: string[];
}

const TONE_PASS_THRESHOLD = 0.6;

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
  const allViolations = [...real.violations, ...supplemental];
  const cats = new Set(allViolations.map((v) => v.category));

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
  add(
    "gear_knowledge",
    "n_a",
    "No automated check yet — would need factsClaimed cross-referenced against a real catalog source, not implemented in this pass.",
  );

  // ── Pricing / quoting ──
  if (has(cats, "MADE_UP_PRICE", "FABRICATED_QUOTE")) {
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
  add(
    "negotiation",
    "n_a",
    "No automated check yet — negotiation-stance correctness needs conversation-level state (HOLD_FIRM/OFFER_ALTERNATIVES/SOFT_YIELD), not scoreable from a single draft in this pass.",
  );

  // ── Discounts / retention ──
  add(
    "discounts_retention",
    "n_a",
    "No automated check yet — discount-tier correctness needs the renter's full context (spend/distance/duration), not scoreable from draft text alone in this pass.",
  );

  // ── Follow-up texting ──
  add(
    "follow_up_texting",
    "n_a",
    "No rule exists in V2 for this yet (confirmed absent — open question in docs/renter-bot-policy.md), so nothing to score against.",
  );

  // ── Cross-account consistency ──
  if (has(cats, "DUAL_ACCOUNT")) {
    add(
      "cross_account_consistency",
      "fail",
      "Draft implied a link between this account and another account's persona.",
      evidenceFor(allViolations, "DUAL_ACCOUNT"),
    );
  } else {
    add("cross_account_consistency", "pass", "No cross-account leak detected.");
  }

  // ── Location handling ──
  if (has(cats, "VAGUE_CONFIRMED_LOCATION", "PREMATURE_CONFIRMATION")) {
    add(
      "location_handling",
      "fail",
      "Draft was vague about a confirmed location, or confirmed/revealed pickup details before booking was actually approved.",
      evidenceFor(allViolations, "VAGUE_CONFIRMED_LOCATION", "PREMATURE_CONFIRMATION"),
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

  // ── Problem solving ──
  add(
    "problem_solving",
    "n_a",
    "No automated check yet — needs qualitative judgment (a human pass or a separate LLM-judge call), not implemented in this pass.",
  );

  // ── Tone / language ──
  const tone = scoreTone(accountSlug, draftText);
  if (tone.score === null) {
    add("tone_language", "n_a", tone.reason ?? "No tone score available.");
  } else if (tone.score >= TONE_PASS_THRESHOLD) {
    add("tone_language", "pass", `Tone score ${tone.score.toFixed(2)} (threshold ${TONE_PASS_THRESHOLD}).`);
  } else {
    add("tone_language", "flag", `Tone score ${tone.score.toFixed(2)} below threshold ${TONE_PASS_THRESHOLD} — review manually.`);
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

  const overall_status: RubricOutput["overall_status"] = results.some(
    (r) => r.status === "fail",
  )
    ? "fail"
    : results.some((r) => r.status === "flag")
      ? "flag"
      : "pass";

  return {
    results,
    overall_status,
    filter_violation_categories: [...cats],
  };
}
