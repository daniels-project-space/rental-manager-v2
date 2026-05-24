/**
 * Shared utility for fuzzy item name matching across services.
 *
 * Ported verbatim from v1 (rental-manager/src/utils/item-matcher.ts) — NestJS-strip only.
 * Algorithm, thresholds, ALIASES, GENERIC_TOKENS, MASTER_INVENTORY, BRAND_FAMILIES,
 * ACCESSORY_ITEMS, FUNCTIONAL_EQUIVALENTS preserved byte-for-byte.
 *
 * MASTER_INVENTORY is the LOCKED authoritative item list (Feb 9 2026).
 * Do NOT edit without Daniel's explicit written permission.
 */

// Common aliases: normalize variant spellings AND brand abbreviations to canonical forms
export const ALIASES: Record<string, string> = {
  microphones: 'mics',
  microphone: 'mic',
  stabiliser: 'stabilizer',
  colour: 'color',
  grey: 'gray',
  centre: 'center',
  // Brand/product abbreviations — Hygglo titles use long forms, inventory uses short
  gmaster: 'gm',
  'g master': 'gm',
  'cinema camera': 'camera',
  'full frame': 'ff',
  monolight: 'light',
  'led light': 'light',
  // Camera model aliases
  'a7v': 'a7 v',
  'a75': 'a7 v',
  'alpha 7 v': 'a7 v',
  'a7 5': 'a7 v',
  'xt5': 'x t5',
  // Aputure model aliases (600X and 600D are DIFFERENT products — no alias)
  '300d': '300d',
  '300d2': '300d ii',
  'amaran': 'amaran',
  // DZO aliases
  dzofilm: 'dzo',
  'dzo film': 'dzo',
  // DJ controller aliases
  'xdj rx2': 'rx2',
  'xdj rx3': 'rx3',
  // Rode aliases
  'wireless go': 'wireless go',
  'wireless go ii': 'wireless go ii',
  ntg5: 'ntg5',
  'ntg 5': 'ntg5',
  // Drone aliases
  'mavic 4': 'mavic 4',
  'mavic4': 'mavic 4',
};

export function normalizeItemName(input: string): string {
  let result = input
    .toLowerCase()
    // Replace hyphens with spaces BEFORE stripping special chars (so "g-master" → "g master" → alias match)
    .replace(/-/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Apply aliases (multi-word first, then single-word to avoid partial matches)
  const sortedAliases = Object.entries(ALIASES).sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of sortedAliases) {
    result = result.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  }

  return result;
}

/**
 * Generate additional token variants for model number matching.
 * E.g., "a7iii" also checks "a7", "a7 iii"; "6k" stays "6k".
 * Only splits when there's an actual number involved (not "vmount" → "v"+"mount").
 */
function getTokenVariants(token: string): string[] {
  const variants = [token];
  if (/\d/.test(token) && /[a-z]/.test(token)) {
    // Try splitting at letter→digit and digit→letter boundaries
    // Aperture tokens like "f28" (from "f2.8") must NOT split into variant "28"
    // — "28" would falsely match focal length numbers (e.g. 28-70mm lens)
    if (/^f\d+$/.test(token)) return variants;
    const split = token.replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2');
    if (split !== token) {
      const parts = split.split(' ');
      // Add the joined alphanumeric prefix: "a7iii" → "a7" (useful model ID)
      // and any meaningful parts (≥2 chars)
      for (const part of parts) {
        if (part.length >= 2 && !variants.includes(part)) {
          variants.push(part);
        }
      }
      // Also add combined prefix forms: "a7iii" → "a7 iii" as a combined variant
      // by including contiguous subsets
      if (parts.length >= 2) {
        const prefix = parts[0] + parts[1]; // e.g., "a7"
        if (prefix.length >= 2 && !variants.includes(prefix)) {
          variants.push(prefix);
        }
      }
    }
  }
  return variants;
}

// Words too generic to match alone — must pair with a product-specific token
export const GENERIC_TOKENS = new Set([
  'wireless', 'audio', 'mic', 'mics', 'video', 'pro', 'set', 'kit', 'light', 'lights',
  'camera', 'cameras', 'lens', 'lenses', 'battery', 'batteries', 'card', 'cards',
  'filter', 'filters', 'mount', 'plate', 'plates',
  'adapter', 'adapters', 'cable', 'cables', 'case', 'bag', 'charger', 'chargers',
  'holder', 'stand', 'stands', 'dome', 'softbox',
  'arm', 'arms', 'support', 'panel', 'panels', 'tube', 'tubes',
  'speaker', 'speakers', 'controller', 'dj',
  'dji', 'jbl', 'nanlite', 'hollyland', 'tilta',
  // NOTE: sony, canon, rode deliberately NOT generic — brand mismatch must block cross-brand matching
  'to', 'for', 'with', 'and', 'the', 'in', 'on', 'of', 'pl',
  'microphone', 'microphones', 'vmount',
  // Quantity markers — too generic to differentiate products
  '1x', '2x', '3x', '4x', '5x', '6x',
  // Noise words common in Hygglo listing titles (NOT model identifiers like gm, iii, ii)
  'zoom', 'tele', 'telephoto', 'wide', 'angle', 'prime', 'ff',
  '4k', 'full', 'frame', 'cinema', 'photo', 'photography', 'filming',
  'professional', 'rental', 'hire', 'rent', 'london', 'uk',
]);

export function findBestMatch(input: string, inventory: string[]): string | null {
  const normalized = normalizeItemName(input);
  if (!normalized) return null;

  // Exact match first
  for (const item of inventory) {
    if (normalizeItemName(item) === normalized) return item;
  }

  // Contains match — only if the shorter string is at least 3 tokens
  // AND shares a brand/product token (prevents cross-brand matches)
  let bestContains: string | null = null;
  let bestContainsLen = 0;
  for (const item of inventory) {
    const normItem = normalizeItemName(item);
    const shorter = normalized.length <= normItem.length ? normalized : normItem;
    if (shorter.split(' ').length >= 3) {
      if (normItem.includes(normalized) || normalized.includes(normItem)) {
        // Prefer the item with the longest overlap
        const overlap = Math.min(normalized.length, normItem.length);
        if (overlap > bestContainsLen) {
          bestContainsLen = overlap;
          bestContains = item;
        }
      }
    }
  }
  if (bestContains) return bestContains;

  // Category keyword matching — only shortcut when exactly ONE inventory item matches
  // (prevents "anamorphic" from returning first of 7 anamorphic lenses)
  const categoryKeywords: Record<string, string[]> = {
    fisheye: ['fisheye', 'fish eye'],
    anamorphic: ['anamorphic', 'blazar', 'remus'],
    gimbal: ['gimbal', 'rs3', 'stabiliser', 'stabilizer'],
    drone: ['drone', 'mavic', 'mini 4', 'avata'],
    tripod: ['tripod'],
    slider: ['slider'],
    monitor: ['monitor', 'atomos ninja', 'hollyland 7'],
    partybox: ['partybox', 'party box'],
    nanlite: ['nanlite', 'pavotube', 'forza'],
  };
  for (const [, keywords] of Object.entries(categoryKeywords)) {
    const matchesInput = keywords.some(kw => normalized.includes(kw));
    if (matchesInput) {
      const candidates = inventory.filter(item => {
        const normItem = normalizeItemName(item);
        return keywords.some(kw => normItem.includes(kw));
      });
      // Before accepting category match, check for variant/model conflicts
      const VARIANT_WORDS_CAT = ['classic', 'pro', 'plus', 'max', 'lite', 'standard', 'ultra'];
      const normTokens = normalized.split(' ');
      const inputVariantsCat = normTokens.filter(t => VARIANT_WORDS_CAT.includes(t));
      const filteredCandidates = candidates.filter(cand => {
        const candNorm = normalizeItemName(cand);
        const candTokens = candNorm.split(' ');
        // Model number conflict
        const candNums = candTokens.filter(t => /^\d{1,4}$/.test(t));
        const inNums = normTokens.filter(t => /^\d{1,4}$/.test(t));
        if (inNums.length > 0 && candNums.length > 0 && !inNums.some(n => candNums.includes(n))) return false;
        // Variant word conflict (classic ≠ pro)
        const candVars = candTokens.filter(t => VARIANT_WORDS_CAT.includes(t));
        if (inputVariantsCat.length > 0 && candVars.length > 0) {
          const common = normTokens.filter(t => candTokens.includes(t) && !VARIANT_WORDS_CAT.includes(t) && t.length >= 2);
          if (common.length >= 2 && !inputVariantsCat.some(v => candVars.includes(v))) return false;
        }
        return true;
      });
      if (filteredCandidates.length === 1) {
        return filteredCandidates[0]; // unambiguous category match after conflict filtering
      }
      if (filteredCandidates.length >= 2) {
        // Multiple category candidates — score them against input to pick the best.
        // Without this, long Hygglo titles like "Manfrotto 190X Tripod + Fluid Video Head"
        // fail generic token scoring (1/18 coverage) even though category is clearly "tripod".
        let bestCatScore = 0;
        let bestCatItem: string | null = null;
        for (const cand of filteredCandidates) {
          const normCand = normalizeItemName(cand);
          const candTokens = normCand.split(' ');
          let score = 0;
          for (const ct of candTokens) {
            if (ct.length < 2) continue;
            if (normalized.includes(ct)) score++;
          }
          // Coverage of the candidate's tokens in the input
          const coverage = candTokens.length > 0 ? score / candTokens.length : 0;
          if (coverage > bestCatScore) {
            bestCatScore = coverage;
            bestCatItem = cand;
          }
        }
        // Return best category candidate if at least the category keyword matched
        if (bestCatItem && bestCatScore > 0) {
          return bestCatItem;
        }
      }
    }
  }

  // Token overlap scoring — stricter rules to prevent false positives
  const inputTokens = normalized.split(' ');
  let bestScore = 0;
  let bestItem: string | null = null;

  // Brand detection for cross-brand blocking
  const BRANDS = ['sony', 'canon', 'blackmagic', 'bmpcc', 'fujifilm', 'panasonic', 'nikon', 'red',
    'aputure', 'nanlite', 'rode', 'dji', 'sennheiser', 'pioneer', 'viewsonic', 'anker', 'arri', 'dzo', 'sigma', '7artisans'];
  const inputBrands = BRANDS.filter(b => normalized.includes(b));

  for (const item of inventory) {
    const normItem = normalizeItemName(item);
    const itemTokens = normItem.split(' ');

    // Brand conflict check: if input specifies a brand not in this inventory item, skip
    if (inputBrands.length > 0) {
      const itemBrands = BRANDS.filter(b => normItem.includes(b));
      if (itemBrands.length > 0 && !inputBrands.some(ib => itemBrands.includes(ib))) {
        continue; // e.g., "Canon RF" input should never match "Sony" inventory item
      }
    }

    let score = 0;
    let specificMatches = 0; // non-generic token matches

    for (const token of inputTokens) {
      if (token.length < 2) continue; // skip tiny tokens like "a", "x"
      const isSubstringMatch = (a: string, b: string) => {
        const shorter = a.length <= b.length ? a : b;
        const longer = a.length > b.length ? a : b;
        return shorter.length >= 4 && longer.includes(shorter) && shorter.length / longer.length >= 0.6;
      };
      // Check token variants for model numbers (e.g., "a7iii" → "a7", "iii")
      // Only expand input tokens to variants; match against original item tokens
      // to prevent FX30's "fx" variant from matching FX3's "fx" variant
      const variants = getTokenVariants(token);
      if (itemTokens.some((t) => variants.some(v => t === v || isSubstringMatch(v, t)))) {
        score++;
        if (!GENERIC_TOKENS.has(token)) {
          specificMatches++;
        }
      }
    }

    // Require at least 1 specific (non-generic) matching token
    if (specificMatches === 0) continue;

    // Require at least 2 matching tokens total
    if (score < 2) continue;

    // Focal length conflict check: if both input and candidate have mm-tokens
    // (e.g., "24mm", "90mm", "200mm") and NONE overlap, these are different lenses.
    // Prevents "Sony 12-24mm f2.8 GM" from matching "Sony GM 90mm f2.8".
    const mmPattern = /^\d+mm$/;
    const inputMmTokens = inputTokens.filter(t => mmPattern.test(t));
    const itemMmTokens = itemTokens.filter(t => mmPattern.test(t));
    if (inputMmTokens.length > 0 && itemMmTokens.length > 0) {
      const hasFocalOverlap = inputMmTokens.some(imt => itemMmTokens.includes(imt));
      if (!hasFocalOverlap) continue; // Different focal lengths = different product
    }

    // Model number conflict check: standalone numeric tokens (1-4 digits) that differ
    // between input and candidate indicate different product versions.
    // Prevents "DJI Mini 3 Pro" matching "DJI Mini 4 Pro", "GoPro 10" matching "GoPro 12".
    const modelNumPattern = /^\d{1,4}$/;
    const inputModelNums = inputTokens.filter(t => modelNumPattern.test(t) && !GENERIC_TOKENS.has(t));
    const itemModelNums = itemTokens.filter(t => modelNumPattern.test(t) && !GENERIC_TOKENS.has(t));
    if (inputModelNums.length > 0 && itemModelNums.length > 0) {
      const hasNumOverlap = inputModelNums.some(n => itemModelNums.includes(n));
      if (!hasNumOverlap) continue; // Different model numbers = different product
    }

    // Product variant conflict: "classic" vs "pro" are different products
    // Prevents "Mavic 3 Classic" matching "DJI Mavic 3 Pro"
    const VARIANT_WORDS = ['classic', 'pro', 'plus', 'max', 'lite', 'mini', 'standard', 'ultra'];
    const inputVariants = inputTokens.filter(t => VARIANT_WORDS.includes(t));
    const itemVariants = itemTokens.filter(t => VARIANT_WORDS.includes(t));
    if (inputVariants.length > 0 && itemVariants.length > 0) {
      // If both have variant words and they differ, check if they share a product base (≥2 common tokens)
      const commonTokens = inputTokens.filter(t => itemTokens.includes(t) && !VARIANT_WORDS.includes(t) && t.length >= 2);
      if (commonTokens.length >= 2 && !inputVariants.some(v => itemVariants.includes(v))) {
        continue; // Same product family but different variant = different product
      }
    }

    // Camera model suffix conflict: a7s ≠ a7, a7r ≠ a7, a7c ≠ a7
    // Extract model designator (s/r/c or empty) and compare, ignoring generation (i/ii/iii/iv/v).
    // "a7siii" and "a7s" both have designator "s"; "a7iii" and "a7" both have designator "".
    const getA7Designator = (tokens: string[]): string | null => {
      for (const t of tokens) {
        const variants = getTokenVariants(t);
        for (const v of variants) {
          const m = v.match(/^a7([src]?)/);
          if (m) return m[1]; // "" for base a7, "s" for a7s, "r" for a7r, "c" for a7c
        }
      }
      return null;
    };
    const inputA7Des = getA7Designator(inputTokens);
    const itemA7Des = getA7Designator(itemTokens);
    if (inputA7Des !== null && itemA7Des !== null && inputA7Des !== itemA7Des) {
      continue; // a7s ≠ a7 = different camera
    }

    // Use coverage of the INVENTORY item (shorter side) as primary metric.
    // This handles long Hygglo titles matching short inventory names.
    // Secondary: require at least 30% of the longer string to prevent pure noise matches.
    const coverageRatio = score / Math.min(inputTokens.length, itemTokens.length);
    const overlapRatio = score / Math.max(inputTokens.length, itemTokens.length);
    if (coverageRatio > bestScore && coverageRatio >= 0.5 && overlapRatio >= 0.25) {
      bestScore = coverageRatio;
      bestItem = item;
    }
  }

  return bestItem;
}

/**
 * Compute the SAME score as findBestMatch for a single (query, candidateString) pair.
 * Returns null if the pair fails any gate (cross-brand, focal-length conflict,
 * model-number conflict, variant conflict, A7-designator conflict, coverage>=0.5,
 * overlap>=0.25, specific-token >=1 OR coverage>=0.7 high-coverage relaxation,
 * total-tokens >=2, brand-mismatch).
 *
 * `displayName` is the canonical name reported in the result. `candidateString`
 * is the string actually compared against the query — either the canonical name
 * itself, or one of the item's aliases (when called via scoreCandidateWithAliases).
 *
 * This is the single source of truth for scoring — used by both findBestMatch
 * (top-1 path) and findTopNMatches (top-N path) so both surface identical results.
 */
function scoreCandidate(
  query: string,
  candidateString: string,
  displayName: string = candidateString,
): { name: string; score: number; coverage: number; overlap: number } | null {
  const normalized = normalizeItemName(query);
  if (!normalized) return null;
  const normItem = normalizeItemName(candidateString);
  const inputTokens = normalized.split(' ');
  const itemTokens = normItem.split(' ');

  // Brand detection mirrors findBestMatch
  const BRANDS = ['sony', 'canon', 'blackmagic', 'bmpcc', 'fujifilm', 'panasonic', 'nikon', 'red',
    'aputure', 'nanlite', 'rode', 'dji', 'sennheiser', 'pioneer', 'viewsonic', 'anker', 'arri', 'dzo', 'sigma', '7artisans'];
  const inputBrands = BRANDS.filter(b => normalized.includes(b));
  if (inputBrands.length > 0) {
    const itemBrands = BRANDS.filter(b => normItem.includes(b));
    if (itemBrands.length > 0 && !inputBrands.some(ib => itemBrands.includes(ib))) {
      return null;
    }
  }

  const isSubstringMatch = (a: string, b: string) => {
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length > b.length ? a : b;
    return shorter.length >= 4 && longer.includes(shorter) && shorter.length / longer.length >= 0.6;
  };

  let score = 0;
  let specificMatches = 0;
  for (const token of inputTokens) {
    if (token.length < 2) continue;
    const variants = getTokenVariants(token);
    if (itemTokens.some((t) => variants.some(v => t === v || isSubstringMatch(v, t)))) {
      score++;
      if (!GENERIC_TOKENS.has(token)) specificMatches++;
    }
  }

  // Require at least 2 matching tokens total
  if (score < 2) return null;

  // Coverage + overlap (computed early so we can use it in the specific-token gate)
  const coverage = score / Math.min(inputTokens.length, itemTokens.length);
  const overlap = score / Math.max(inputTokens.length, itemTokens.length);

  // Specific-token gate with high-coverage escape hatch.
  // Normal rule: at least 1 non-generic matching token.
  // Relaxation: when ≥70% of the shorter side's tokens overlap AND ≥50% of
  // the longer side's, the query is effectively the same product even if
  // every matched token is "generic" (wireless, mics, dji, jbl, etc.).
  // This unblocks queries like "DJI Mic 2 wireless" → "DJI Mic 2 wireless"
  // and "JBL wireless microphones" → "JBL wireless microphones" where the
  // canonical name itself is built from generic vocabulary.
  const HIGH_COVERAGE = 0.7;
  const HIGH_COVERAGE_OVERLAP = 0.5;
  if (specificMatches === 0 && !(coverage >= HIGH_COVERAGE && overlap >= HIGH_COVERAGE_OVERLAP)) {
    return null;
  }

  // Focal length conflict
  const mmPattern = /^\d+mm$/;
  const inputMmTokens = inputTokens.filter(t => mmPattern.test(t));
  const itemMmTokens = itemTokens.filter(t => mmPattern.test(t));
  if (inputMmTokens.length > 0 && itemMmTokens.length > 0) {
    if (!inputMmTokens.some(imt => itemMmTokens.includes(imt))) return null;
  }

  // Model number conflict
  const modelNumPattern = /^\d{1,4}$/;
  const inputModelNums = inputTokens.filter(t => modelNumPattern.test(t) && !GENERIC_TOKENS.has(t));
  const itemModelNums = itemTokens.filter(t => modelNumPattern.test(t) && !GENERIC_TOKENS.has(t));
  if (inputModelNums.length > 0 && itemModelNums.length > 0) {
    if (!inputModelNums.some(n => itemModelNums.includes(n))) return null;
  }

  // Variant conflict (classic ≠ pro)
  const VARIANT_WORDS = ['classic', 'pro', 'plus', 'max', 'lite', 'mini', 'standard', 'ultra'];
  const inputVariants = inputTokens.filter(t => VARIANT_WORDS.includes(t));
  const itemVariants = itemTokens.filter(t => VARIANT_WORDS.includes(t));
  if (inputVariants.length > 0 && itemVariants.length > 0) {
    const commonTokens = inputTokens.filter(t => itemTokens.includes(t) && !VARIANT_WORDS.includes(t) && t.length >= 2);
    if (commonTokens.length >= 2 && !inputVariants.some(v => itemVariants.includes(v))) return null;
  }

  // A7-designator conflict
  const getA7Designator = (tokens: string[]): string | null => {
    for (const t of tokens) {
      const variants = getTokenVariants(t);
      for (const v of variants) {
        const m = v.match(/^a7([src]?)/);
        if (m) return m[1];
      }
    }
    return null;
  };
  const inputA7Des = getA7Designator(inputTokens);
  const itemA7Des = getA7Designator(itemTokens);
  if (inputA7Des !== null && itemA7Des !== null && inputA7Des !== itemA7Des) return null;

  // Coverage + overlap gates (same as findBestMatch)
  if (coverage < 0.5 || overlap < 0.25) return null;

  // Final brand-mismatch gate (uses extractPrimaryBrand semantics on raw names).
  // Compare against displayName (canonical), not the alias, so brand extraction
  // works the same regardless of which alias scored.
  if (detectBrandMismatch(query, displayName).isMismatch) return null;

  return { name: displayName, score: coverage, coverage, overlap };
}

/** Inventory candidate with optional alternate spellings. */
export type ScoredCandidate = {
  /** Canonical / display name returned in match results. */
  name: string;
  /** Extra spellings to score against. Empty = canonical-only. */
  aliases?: string[];
};

/**
 * Score a candidate against [name, ...aliases] and return the best-scoring
 * result. Ties prefer name_canonical over aliases so logging stays clean.
 */
function scoreCandidateWithAliases(
  query: string,
  candidate: ScoredCandidate,
): { name: string; score: number; coverage: number; overlap: number } | null {
  const canonicalHit = scoreCandidate(query, candidate.name, candidate.name);
  let best = canonicalHit;
  for (const alias of candidate.aliases ?? []) {
    if (!alias) continue;
    const aliasHit = scoreCandidate(query, alias, candidate.name);
    if (!aliasHit) continue;
    // Tie-break: prefer canonical when score is equal (logging stays clean).
    if (!best || aliasHit.score > best.score) {
      best = aliasHit;
    }
  }
  return best;
}

/** Accept either a bare name list or a list of {name, aliases} objects. */
function normalizeCandidates(
  candidates: ReadonlyArray<string | ScoredCandidate>,
): ScoredCandidate[] {
  return candidates.map((c) =>
    typeof c === 'string' ? { name: c, aliases: [] } : { name: c.name, aliases: c.aliases ?? [] },
  );
}

/**
 * Return the top-N inventory matches for a query, applying the EXACT same
 * scoring rule as findBestMatch (GENERIC_TOKENS exclusion, coverage>=0.5,
 * overlap>=0.25, brand-mismatch + conflict gates). Sorted by score desc.
 *
 * `candidates` may be either a flat string[] (canonical names only) or
 * {name, aliases}[] — when aliases are supplied each is also scored and
 * the max wins (tie-breaks on the canonical name).
 *
 * If fewer than N items pass thresholds, returns what we have (may be empty).
 */
export function findTopNMatches(
  query: string,
  candidates: ReadonlyArray<string | ScoredCandidate>,
  n: number = 3,
): Array<{ name: string; score: number; coverage: number; overlap: number }> {
  const norm = normalizeCandidates(candidates);
  const scored: Array<{ name: string; score: number; coverage: number; overlap: number }> = [];
  for (const cand of norm) {
    const hit = scoreCandidateWithAliases(query, cand);
    if (hit) scored.push(hit);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n);
}

/**
 * Score-returning variant of findBestMatch for callers that need confidence.
 * Thin wrapper over findTopNMatches for backwards compatibility.
 * Accepts either a bare canonical-name list or {name, aliases}[] (aliases
 * are scored against the query and the best score wins).
 * Returns null if nothing matches; otherwise { name, score } where score is coverageRatio.
 */
export function findBestMatchWithScore(
  input: string,
  inventory: ReadonlyArray<string | ScoredCandidate>,
): { name: string; score: number } | null {
  const top = findTopNMatches(input, inventory, 1);
  if (top.length === 0) return null;
  return { name: top[0].name, score: top[0].score };
}

/**
 * Items that are accessories — bundled with cameras but should never create standalone bookings.
 * Revenue should be attributed to the main equipment item, not split with accessories.
 */
export const ACCESSORY_ITEMS = new Set([
  'PL to Sony E mount',
  'PL to EF mount',
  'PL to RF mount',
  'PL to L mount',
  'CF Express Type A card',
  'ND filter',
  'Cinebloom filter mist',
  '256GB card',
  'DJI gimbal battery',
  'Sony NP-FZ100 batteries 2x sets',
  'Sony NP-F970 batteries 2x sets',
  'V-mount 95mAh',
  'V-mount 150mAh',
  'Suction cups',
]);

export function isAccessoryItem(name: string): boolean {
  return ACCESSORY_ITEMS.has(name);
}

/**
 * Functional equivalents — items that serve the same purpose and can be offered
 * as alternatives when the requested item is held in contention.
 * Cross-brand where appropriate (e.g. DJI mic ↔ Rode Wireless Pro).
 */
export const FUNCTIONAL_EQUIVALENTS: Record<string, string[]> = {
  // Wireless microphone systems (lavalier-capable)
  'DJI Wireless Mics':       ['DJI Mic 2 wireless', 'Rode Wireless Mic Pro set'],
  'DJI Mic 2 wireless':      ['DJI Wireless Mics', 'Rode Wireless Mic Pro set'],
  'Rode Wireless Mic Pro set': ['DJI Wireless Mics', 'DJI Mic 2 wireless'],
  'JBL wireless microphones': ['DJI Wireless Mics', 'DJI Mic 2 wireless', 'Rode Wireless Mic Pro set'],
  // On-camera / shotgun mics
  'Rode Video Mic Go':        ['Rode Video Mic Pro Plus', 'Audio boom mic Sennheiser'],
  'Rode Video Mic Pro Plus':  ['Rode Video Mic Go', 'Audio boom mic Sennheiser'],
  // Sony mirrorless camera bodies
  'Sony FX3':    ['Sony A7 V', 'Sony A7 III', 'Sony A7 II'],
  'Sony A7 V':   ['Sony FX3', 'Sony A7 III'],
  'Sony A7 III': ['Sony FX3', 'Sony A7 V', 'Sony A7 II'],
  'Sony A7 II':  ['Sony A7 III', 'Sony A7 V'],
  // DJI drones
  'DJI Mavic 3 Pro': ['DJI Mini 4 Pro'],
  'DJI Mini 4 Pro':  ['DJI Mavic 3 Pro'],
  // Action cameras
  'DJI Osmo Action Pro 5': ['GoPro 12 Hero'],
  'GoPro 12 Hero':         ['DJI Osmo Action Pro 5'],
  // Gimbals
  'DJI RS3 Pro gimbal': [],
  // Tripods
  'Small rig tripod': ['Sirui tripod'],
  'Sirui tripod':     ['Small rig tripod'],
  // Lights (approx equivalents by output level)
  'Nanlite 500B':          ['Nanlite Forza 300'],
  'Nanlite Forza 300':     ['Nanlite 500B'],
  'LED light panels RGB':  ['Ambitful RGB light tubes 2x set', 'Nanlite Pavotube 30x II'],
  'Nanlite Pavotube 30x II': ['Ambitful RGB light tubes 2x set', 'LED light panels RGB'],
  'Ambitful RGB light tubes 2x set': ['Nanlite Pavotube 30x II', 'LED light panels RGB'],
};

/**
 * DEFINITIVE MASTER INVENTORY — Daniel's authoritative list (Feb 9 2026).
 * DO NOT EDIT without Daniel's explicit written permission.
 * Everything not on this list is marketing-only (externally: "currently out of stock").
 *
 * NOTE: ported v1 shape preserved (Record<string, number> = name → max qty).
 */
export const MASTER_INVENTORY: Record<string, number> = {
  // Anamorphic lenses
  'Anamorphic Blazar Remus 33mm': 1,
  'Anamorphic Blazar Remus 45mm': 1,
  'Anamorphic Blazar Remus 65mm': 1,
  'Anamorphic Blazar Remus 100mm': 1,
  // Sony lenses
  'Sony GM 24-70mm f2.8': 4,
  'Sony GM 16-35mm f2.8': 1,
  'Sony GM 70-200mm f2.8': 2,
  'Sony GM 90mm f2.8': 1,
  'Sony 28-70mm': 2,
  'Sony 11mm f2.8 fisheye': 1,
  // Canon lenses
  'Canon EF 24-105mm f4': 1,
  'Canon EF 16-35mm f2.8': 1,
  // Camera bodies
  'Sony FX3': 3,
  'Sony A7 III': 1,
  'Sony A7 V': 1,
  'Sony A7 II': 1,
  'Fujifilm X100 VI': 1,
  'BMPCC 6K Pro': 1,
  'BMPCC 6K Full Frame': 1,
  // Lights & modifiers
  'Softbox 85cm': 2,
  'LED light panels RGB': 3,
  'Nanlite Forza 300': 1,
  'Nanlite Pavotube 30x II': 4,
  'Nanlite 500B': 1,
  'Ambitful RGB light tubes 2x set': 2,
  '5-in-1 reflector panel': 1,
  'Camera flash': 1,
  // Power
  'V-mount 95mAh': 2,
  'V-mount 150mAh': 4,
  'Sony NP-FZ100 batteries 2x sets': 4,
  'SmallRig FX3 cage': 1,
  'Sony NP-F970 batteries 2x sets': 4,
  'DJI gimbal battery': 3,
  'Anker Power Station F2000': 1,
  // Support & gimbals
  'C-stand': 1,
  'Small rig tripod': 3,
  'Sirui tripod': 1,
  'DJI RS3 Pro gimbal': 2,
  'Motorized slider': 1,
  'Tilta Nucleus Nano 2 follow focus': 1,
  'Tilta shoulder rig': 1,
  'Monopod arm support': 1,
  // Monitors & transmitters
  'Atomos Ninja V': 1,
  'Hollyland Mars 4K transmitter': 1,
  'Hollyland Pyro S transmitter': 1,
  'Hollyland 7-inch monitor': 1,
  // Audio
  'Rode Video Mic Go': 1,
  'Rode Wireless Mic Pro set': 2,
  'Rode Video Mic Pro Plus': 1,
  'Audio boom mic Sennheiser': 2,  // MKE 600 + original
  'DJI Wireless Mics': 1,
  'DJI Mic 2 wireless': 1,
  'JBL wireless microphones': 1,
  // Drones & action cams
  'DJI Mavic 3 Pro': 1,
  'DJI Mini 4 Pro': 1,
  'DJI Osmo Action Pro 5': 3,
  'GoPro 12 Hero': 3,
  'Suction cups': 6,
  // DJ & speakers
  'DJ RX3 Pioneer controller': 1,
  'JBL Club 120 speaker': 2,
  'JBL PartyBox 110': 1,
  // Smoke & effects
  'Smoke machine fogger': 1,
  'Smoke Ninja Pro hazer': 1,
  'Smoke Ninja': 1,
  // Filters & cards
  'ND filter': 3,
  'Cinebloom filter mist': 1,
  '256GB card': 3,
  'CF Express Type A card': 3,  // 1 original + 2x 320GB (Apr 2026)
  // Mount adapters
  'PL to Sony E mount': 2,
  'PL to EF mount': 1,
  'PL to RF mount': 1,
  'PL to L mount': 1,
};

export function getInventoryItemNames(): string[] {
  return Object.keys(MASTER_INVENTORY);
}

/** Convenience: pre-extracted key list used as `candidates` for matcher tests/callers. */
export const MASTER_INVENTORY_KEYS: string[] = Object.keys(MASTER_INVENTORY);

/**
 * BRAND INTEGRITY GATE — Detects cross-brand substitutions.
 *
 * Given a listing title and a matched inventory item, determines whether
 * the match is a genuine same-brand match or a cross-brand substitution.
 *
 * Returns null if no brand detected (neutral), or a mismatch descriptor.
 * This is NOT regex — it uses semantic brand extraction with SEO noise stripping.
 */

// Canonical brand families: group misspellings, abbreviations, sub-brands
const BRAND_FAMILIES: Record<string, string[]> = {
  sony:       ['sony', 'α', 'alpha'],
  canon:      ['canon', 'cannon', 'eos'],
  blackmagic: ['blackmagic', 'bmpcc', 'bmpc', 'pyxis'],
  fujifilm:   ['fujifilm', 'fuji'],
  panasonic:  ['panasonic', 'lumix'],
  nikon:      ['nikon', 'nikkor'],
  red:        ['red', 'dsmc'],
  arri:       ['arri', 'alexa'],
  dji:        ['dji'],
  rode:       ['rode', 'røde'],
  sennheiser: ['sennheiser'],
  dzo:        ['dzo', 'dzofilm', 'vespid'],
  sigma:      ['sigma'],
  aputure:    ['aputure'],
  nanlite:    ['nanlite'],
  hollyland:  ['hollyland'],
  tilta:      ['tilta'],
  gopro:      ['gopro', 'go pro'],
  pioneer:    ['pioneer', 'xdj'],
  jbl:        ['jbl'],
  blazar:     ['blazar', 'remus'],
  '7artisans': ['7artisans'],
  smallrig:   ['smallrig', 'small rig'],
  atomos:     ['atomos', 'ninja'],
  anker:      ['anker'],
};

/**
 * Extract the primary brand from text, ignoring SEO comparison noise.
 * Strips "(like X / Y)" and "(similar to ...)" before extraction.
 * Returns the FIRST (leftmost) brand found — the primary product brand.
 */
export function extractPrimaryBrand(text: string): string | null {
  // Strip SEO comparison clauses BEFORE brand detection
  const cleaned = text
    .replace(/\(\s*(?:like|similar to|comparable to|replaces|vs|or|same\s+(?:sensor|chip|quality|level|class)\s+as|equivalent to|alternative to|beats|better than|compared to|upgrade from|matching|competes\s+with|rival\s+to|works\s+like)\s[^)]*\)/gi, '')
    .replace(/[|–—]\s*(?:like|similar|comparable|replaces|vs)\b[^|–—]*/gi, '') // pipe-separated SEO
    .toLowerCase();

  // Find the leftmost brand mention
  let earliestPos = Infinity;
  let primaryBrand: string | null = null;

  for (const [canonical, variants] of Object.entries(BRAND_FAMILIES)) {
    for (const variant of variants) {
      const pos = cleaned.indexOf(variant);
      if (pos !== -1 && pos < earliestPos) {
        earliestPos = pos;
        primaryBrand = canonical;
      }
    }
  }

  return primaryBrand;
}

/**
 * Extract ALL brands from text (after stripping SEO noise).
 */
export function extractAllBrands(text: string): string[] {
  const cleaned = text
    .replace(/\(\s*(?:like|similar to|comparable to|replaces|vs|or|same\s+(?:sensor|chip|quality|level|class)\s+as|equivalent to|alternative to|beats|better than|compared to|upgrade from|matching|competes\s+with|rival\s+to|works\s+like)\s[^)]*\)/gi, '')
    .replace(/[|–—]\s*(?:like|similar|comparable|replaces|vs)\b[^|–—]*/gi, '')
    .toLowerCase();

  const found: string[] = [];
  for (const [canonical, variants] of Object.entries(BRAND_FAMILIES)) {
    if (variants.some(v => cleaned.includes(v)) && !found.includes(canonical)) {
      found.push(canonical);
    }
  }
  return found;
}

export interface BrandMatchResult {
  isMismatch: boolean;
  listingBrand: string | null;
  itemBrand: string | null;
  /** Human-readable explanation for AI prompts */
  explanation: string;
}

/**
 * Core brand integrity check: does the listing title's brand match the
 * matched inventory item's brand?
 *
 * Cases:
 * - Same brand → direct match (ok)
 * - Listing has a brand, item has a DIFFERENT brand → cross-brand mismatch
 * - Listing has no detectable brand → neutral (allow match)
 * - Item has no detectable brand (accessories) → neutral (allow match)
 * - Multi-brand listing (e.g. "BMPCC + Canon lens") → check per-component
 */
export function detectBrandMismatch(listingTitle: string, matchedInventoryItem: string): BrandMatchResult {
  const listingBrand = extractPrimaryBrand(listingTitle);
  const itemBrand = extractPrimaryBrand(matchedInventoryItem);

  // No brand detected on either side → neutral, allow
  if (!listingBrand || !itemBrand) {
    return { isMismatch: false, listingBrand, itemBrand, explanation: '' };
  }

  // Same brand family → direct match
  if (listingBrand === itemBrand) {
    return { isMismatch: false, listingBrand, itemBrand, explanation: '' };
  }

  // Special case: Blackmagic cameras use Canon/Sony lenses legitimately
  // "BMPCC + Canon lens" is a real combo, not a mismatch
  if (listingBrand === 'blackmagic' || itemBrand === 'blackmagic') {
    // Check if the listing mentions BOTH brands explicitly (combo listing)
    const allListingBrands = extractAllBrands(listingTitle);
    if (allListingBrands.includes(listingBrand) && allListingBrands.includes(itemBrand)) {
      return { isMismatch: false, listingBrand, itemBrand, explanation: '' };
    }
  }

  // Cross-brand accessories / support gear are often brand-agnostic
  // These items work with any camera brand — don't flag as mismatch
  const accessoryPatterns = /\b(batter|card|mount|adapter|filter|tripod|gimbal|mic|light|stand|cable|rig|focus|slider|monopod|softbox|reflector|c-stand|smoke|flash|suction)\b/i;
  if (accessoryPatterns.test(matchedInventoryItem)) {
    return { isMismatch: false, listingBrand, itemBrand, explanation: '' };
  }

  // Also check the ACCESSORY_ITEMS set directly
  if (ACCESSORY_ITEMS.has(matchedInventoryItem)) {
    return { isMismatch: false, listingBrand, itemBrand, explanation: '' };
  }

  // Cross-brand mismatch: listing says one brand, matched item is another
  return {
    isMismatch: true,
    listingBrand,
    itemBrand,
    explanation: `LISTING MISMATCH: Renter ordered "${listingTitle}" (${listingBrand.toUpperCase()} product) but matched to "${matchedInventoryItem}" (${itemBrand.toUpperCase()}). These are DIFFERENT brands with incompatible mounts. Frame as "this specific item is currently unavailable" and offer the ${itemBrand.toUpperCase()} alternative.`,
  };
}

/**
 * Check whether a listing title maps to a real inventory item.
 * Returns the matched inventory item name, or null if this is
 * a ghost / SEO listing with no physical stock.
 */
export function validateListingAgainstInventory(listingTitle: string): {
  matched: boolean;
  inventoryItem: string | null;
  maxQuantity: number;
} {
  const inventoryNames = getInventoryItemNames();
  const match = findBestMatch(listingTitle, inventoryNames);
  if (match) {
    return { matched: true, inventoryItem: match, maxQuantity: MASTER_INVENTORY[match] };
  }
  return { matched: false, inventoryItem: null, maxQuantity: 0 };
}

/**
 * Multi-item listing validation. Splits combo titles (e.g. "FX3 + 28-70mm lens")
 * into parts and validates each independently. Handles the case where the full title
 * doesn't match but individual components do.
 */
export function validateListingItems(listingTitle: string): {
  items: { name: string; matched: boolean; inventoryItem: string | null; maxQuantity: number }[];
  allMatched: boolean;
  someMatched: boolean;
  noneMatched: boolean;
  isComboListing: boolean;
} {
  const inventoryNames = getInventoryItemNames();

  // First try the full title as a single match
  const fullMatch = findBestMatch(listingTitle, inventoryNames);
  if (fullMatch) {
    return {
      items: [{ name: listingTitle, matched: true, inventoryItem: fullMatch, maxQuantity: MASTER_INVENTORY[fullMatch] }],
      allMatched: true,
      someMatched: true,
      noneMatched: false,
      isComboListing: false,
    };
  }

  // Split on combo separators: +, &, "and", "with", commas
  const parts = listingTitle
    .split(/\s*(?:\+|&|,)\s*|\s+(?:and|with)\s+/i)
    .map(p => p.trim())
    .filter(p => p.length > 2);

  // If no meaningful split, treat as single unmatched item
  if (parts.length <= 1) {
    return {
      items: [{ name: listingTitle, matched: false, inventoryItem: null, maxQuantity: 0 }],
      allMatched: false,
      someMatched: false,
      noneMatched: true,
      isComboListing: false,
    };
  }

  // Validate each part independently
  const items = parts.map(part => {
    const match = findBestMatch(part, inventoryNames);
    return {
      name: part,
      matched: !!match,
      inventoryItem: match || null,
      maxQuantity: match ? MASTER_INVENTORY[match] : 0,
    };
  });

  const matchedCount = items.filter(i => i.matched).length;
  return {
    items,
    allMatched: matchedCount === items.length,
    someMatched: matchedCount > 0 && matchedCount < items.length,
    noneMatched: matchedCount === 0,
    isComboListing: true,
  };
}

/**
 * Extract the requested quantity from a listing title (e.g. "4x Anker F2000" → 4).
 * Returns 1 if no quantity prefix is found.
 */
export function extractListingQuantity(listingTitle: string): number {
  const match = listingTitle.match(/^(\d+)\s*x\s+/i);
  return match ? parseInt(match[1], 10) : 1;
}
