/**
 * Wave 4.7 — Grok model version parsing + comparison policy.
 *
 * Used by the monthly auto-upgrade scanner. Pure functions only — no I/O,
 * no env reads — so they can be exercised in `scripts/test-model-scan.mjs`
 * without scheduling Trigger jobs.
 *
 * Recommendation table:
 *   - same MAJOR + higher MINOR        → "auto_pr"   (safe, just bump)
 *   - higher MAJOR (e.g. grok-5*)      → "advisory"  (notify human)
 *   - SKU suffix appears in candidate
 *     that current pin lacks
 *     (-fast | -reasoning | -mini |
 *      -code | -vision)                → "advisory"  (notify human)
 *   - nothing newer                    → "no_change"
 */

const SKU_SUFFIXES = ["fast", "reasoning", "mini", "code", "vision"] as const;
type SkuSuffix = (typeof SKU_SUFFIXES)[number];

export type ParsedModel = {
  raw: string;
  major: number;
  minor: number;
  /** e.g. for `grok-5-mini` → `["mini"]`. Sorted for stable comparison. */
  suffixes: SkuSuffix[];
};

/** Returns null if the id isn't a recognisable `grok-MAJOR(.MINOR)?(-suffix)*`. */
export function parseGrokModel(id: string): ParsedModel | null {
  const m = /^grok-(\d+)(?:\.(\d+))?(?:-(.+))?$/i.exec(id.trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = m[2] !== undefined ? Number(m[2]) : 0;
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;

  const rest = (m[3] ?? "").toLowerCase();
  const suffixes: SkuSuffix[] = [];
  if (rest) {
    for (const part of rest.split(/[-_.]+/)) {
      if ((SKU_SUFFIXES as readonly string[]).includes(part)) {
        suffixes.push(part as SkuSuffix);
      }
    }
  }
  suffixes.sort();
  return { raw: id, major, minor, suffixes };
}

export type Recommendation = "no_change" | "auto_pr" | "advisory";

export type CompareOutcome = {
  recommendation: Recommendation;
  recommendedModel: string | null;
  /** Human-readable rationale for the audit row. */
  reason: string;
};

/**
 * Decide the action for a single candidate vs the currently pinned model.
 * The caller iterates the model list and picks the strongest recommendation
 * (auto_pr > advisory > no_change).
 */
export function compareSingle(
  current: ParsedModel,
  candidate: ParsedModel,
): CompareOutcome {
  // Same SKU shape required for an auto bump.
  const sameShape =
    JSON.stringify(current.suffixes) === JSON.stringify(candidate.suffixes);

  if (candidate.major > current.major) {
    return {
      recommendation: "advisory",
      recommendedModel: candidate.raw,
      reason: `Candidate ${candidate.raw} is a MAJOR version above current ${current.raw}; requires human review.`,
    };
  }

  // SKU surface change at the same major — always advisory.
  const currentHasNoSkus = current.suffixes.length === 0;
  const candidateHasNewSkus = candidate.suffixes.some(
    (s) => !current.suffixes.includes(s),
  );
  if (!sameShape && (currentHasNoSkus || candidateHasNewSkus)) {
    return {
      recommendation: "advisory",
      recommendedModel: candidate.raw,
      reason: `Candidate ${candidate.raw} introduces SKU change vs ${current.raw}; requires human review.`,
    };
  }

  if (
    sameShape &&
    candidate.major === current.major &&
    candidate.minor > current.minor
  ) {
    return {
      recommendation: "auto_pr",
      recommendedModel: candidate.raw,
      reason: `Minor-version bump ${current.raw} → ${candidate.raw}; same SKU shape.`,
    };
  }

  return {
    recommendation: "no_change",
    recommendedModel: null,
    reason: `Candidate ${candidate.raw} is not newer than ${current.raw}.`,
  };
}

/** Strength ordering — used to pick the strongest recommendation in a list. */
const STRENGTH: Record<Recommendation, number> = {
  no_change: 0,
  advisory: 1,
  auto_pr: 2,
};

/**
 * Scan a candidate list and return the strongest recommendation against
 * the currently pinned model.
 */
export function decideRecommendation(
  currentModelId: string,
  candidates: string[],
): CompareOutcome & { allOutcomes: CompareOutcome[] } {
  const current = parseGrokModel(currentModelId);
  if (!current) {
    return {
      recommendation: "no_change",
      recommendedModel: null,
      reason: `Could not parse current model id '${currentModelId}'`,
      allOutcomes: [],
    };
  }

  const outcomes: CompareOutcome[] = [];
  for (const c of candidates) {
    const parsed = parseGrokModel(c);
    if (!parsed) continue;
    if (parsed.raw === current.raw) continue;
    outcomes.push(compareSingle(current, parsed));
  }

  // For auto_pr, prefer the HIGHEST minor bump. For advisory, prefer the highest major.
  const autoPrs = outcomes.filter((o) => o.recommendation === "auto_pr");
  if (autoPrs.length > 0) {
    autoPrs.sort((a, b) => {
      const am = parseGrokModel(a.recommendedModel!)!.minor;
      const bm = parseGrokModel(b.recommendedModel!)!.minor;
      return bm - am;
    });
    return { ...autoPrs[0]!, allOutcomes: outcomes };
  }

  const advisories = outcomes.filter((o) => o.recommendation === "advisory");
  if (advisories.length > 0) {
    advisories.sort((a, b) => {
      const am = parseGrokModel(a.recommendedModel!)!.major;
      const bm = parseGrokModel(b.recommendedModel!)!.major;
      return bm - am;
    });
    return { ...advisories[0]!, allOutcomes: outcomes };
  }

  return {
    recommendation: "no_change",
    recommendedModel: null,
    reason: `No newer model found among ${outcomes.length} candidates.`,
    allOutcomes: outcomes,
  };
}
