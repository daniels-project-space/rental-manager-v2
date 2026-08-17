/**
 * renter_bot_filters_supplemental — TEST-ONLY violation checks covering the
 * gap between V1's 17-rule scanner (rental-manager/test-harness.ts) and V2's
 * production `renter_bot_filters.ts`: DUAL_ACCOUNT, MADE_UP_PRICE,
 * EMPTY_RESPONSE/TOO_LONG, LOCATION_PLACEHOLDER/FORMAT_ARTIFACT.
 *
 * Same FilterViolation shape as the real filters, but this file is used only
 * by the harness/rubric — never imported by production draft-generation code.
 * Regex heuristics below are a first pass; expect to tune thresholds/patterns
 * once real fixture runs show false positives/negatives.
 */
import type { FilterViolation } from "./renter_bot_filters";

export interface FactClaim {
  kind: string;
  value: string;
  verified: boolean;
}

// account_slug -> the persona name it must never link itself to another
// account's persona through (real slugs, confirmed in convex/lib/reservations/accounts.ts).
const ACCOUNT_PERSONAS: Record<string, string> = {
  dbcinema_web: "Daniel",
  leo: "Leo",
  diogo: "Diogo",
};

const SAME_BUSINESS_LINK =
  /\b(same (business|person|owner|company|team)|also (known as|goes by)|i'?m also)\b/i;

const PRICE_PATTERN = /[£$]\s?\d+(\.\d{1,2})?/g;

const PLACEHOLDER_PATTERN = /\[[^\]]{1,40}\]|\{\{[^}]{1,40}\}\}|\btbc\b|\bTBD\b/i;

const FORMAT_ARTIFACT_PATTERN =
  /```|^#{1,6}\s|\*\*[^*]+\*\*|^\s*\{[\s\S]*"draft"/m;

// v1's "good" DBCinema-tone zone tops out at 120 words; give real replies
// headroom before flagging.
const TOO_LONG_WORD_COUNT = 180;

export function applySupplementalFilters(
  draft: string,
  accountSlug: string,
  factsClaimed: FactClaim[] = [],
): FilterViolation[] {
  const violations: FilterViolation[] = [];
  const push = (
    category: string,
    action: FilterViolation["action"],
    matchedText?: string,
    hint?: string,
  ) => violations.push({ category, action, matchedText, hint });

  if (draft.trim().length === 0) {
    push(
      "EMPTY_RESPONSE",
      "block",
      undefined,
      "Draft is empty — should have escalated (needs_human) instead.",
    );
  }

  const wordCount = draft.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount > TOO_LONG_WORD_COUNT) {
    push(
      "TOO_LONG",
      "flag",
      undefined,
      `${wordCount} words — texting-length replies read as more human.`,
    );
  }

  const selfName = ACCOUNT_PERSONAS[accountSlug];
  for (const [otherSlug, otherName] of Object.entries(ACCOUNT_PERSONAS)) {
    if (otherSlug === accountSlug || otherName === selfName) continue;
    const nameHit = new RegExp(`\\b${otherName}\\b`).exec(draft);
    if (nameHit && SAME_BUSINESS_LINK.test(draft)) {
      push(
        "DUAL_ACCOUNT",
        "block",
        nameHit[0],
        `Draft for account "${accountSlug}" implies a link to another account's persona (${otherName}) — never disclose shared ownership across accounts.`,
      );
    }
  }

  // NOTE: generateDraft's fallback code path (used whenever the primary Mastra
  // agent call doesn't succeed) legitimately never populates factsClaimed at
  // all — it grounds pricing via prompt-injected listing facts instead, which
  // this harness has no visibility into. So an EMPTY factsClaimed array is NOT
  // evidence of a fabricated price, just evidence we can't verify either way.
  // Only a NON-empty factsClaimed that fails to contain a matching price is a
  // real, confident signal.
  const priceMentions = draft.match(PRICE_PATTERN) ?? [];
  if (priceMentions.length > 0) {
    if (factsClaimed.length === 0) {
      for (const m of priceMentions) {
        push(
          "UNVERIFIABLE_PRICE",
          "flag",
          m,
          "Price mentioned but this run returned no factsClaimed data at all (expected on the fallback generation path) — can't confirm or refute it from here, worth a manual look.",
        );
      }
    } else {
      const verifiedPrices = new Set(
        factsClaimed
          .filter((f) => f.kind === "price" && f.verified)
          .map((f) => f.value.replace(/[^0-9.]/g, "")),
      );
      for (const m of priceMentions) {
        const digits = m.replace(/[^0-9.]/g, "");
        if (!verifiedPrices.has(digits)) {
          push(
            "MADE_UP_PRICE",
            "flag",
            m,
            "Price mentioned with no matching verified fact in a non-empty factsClaimed — this run DID return fact-check data and this price isn't in it.",
          );
        }
      }
    }
  }

  const placeholderHit = PLACEHOLDER_PATTERN.exec(draft);
  if (placeholderHit) {
    push(
      "LOCATION_PLACEHOLDER",
      "flag",
      placeholderHit[0],
      "Looks like an unfilled template artifact, not a deliberate withheld-address response.",
    );
  }

  const formatHit = FORMAT_ARTIFACT_PATTERN.exec(draft);
  if (formatHit) {
    push(
      "FORMAT_ARTIFACT",
      "flag",
      formatHit[0].slice(0, 40),
      "Raw markdown/JSON structure leaking into renter-visible text.",
    );
  }

  return violations;
}
