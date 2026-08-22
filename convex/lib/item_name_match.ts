/**
 * item_name_match.ts — shared, MODEL-DISCRIMINATIVE item-name matching.
 *
 * Why this exists (2026-08-21):
 * Three different tools each rolled their own bag-of-words matcher, and every
 * one of them lost the tokens that actually distinguish two bodies:
 *
 *   - find_owned_alternatives put "pro", "full", "frame" in its STOP list, so
 *     "BMPCC 6K Pro" and "BMPCC 6K Full Frame" both reduced to {bmpcc, 6k} —
 *     literally indistinguishable, which is how a Pro request got answered
 *     with a Full Frame.
 *   - lookup_pricing scored pure COVERAGE (hits / query-token-count) against
 *     long marketing listing names, so "BMPCC 6K Pro" scored a perfect 1.0
 *     against "Blackmagic cinema camera full frame 6k Bmpcc + Rode video mic
 *     PRO plus microphone + tripod" — the "pro" came from the MICROPHONE.
 *     Wrong body, wrong kit, 2x the price.
 *
 * The fix is Jaccard-style scoring over tokens that keep their variant words.
 * Coverage alone rewards a long listing name for accidentally containing a
 * token; Jaccard penalises the extra tokens the query never asked for, so a
 * bare-item query stops matching a fat bundle listing.
 *
 * Pure functions, no Convex imports — unit-testable in isolation.
 */

/**
 * Words that carry NO model information and are safe to drop. Deliberately
 * short: anything that could distinguish two products (pro, full, frame, mini,
 * max, ii, mk2, ...) must NEVER be here.
 */
const STOP = new Set([
  "the", "and", "for", "with", "a", "an", "of", "to", "in", "on",
  "or", "like", "alternative", "equivalent", "similar",
]);

const ROMAN: Record<string, string> = {
  i: "1", ii: "2", iii: "3", iv: "4", v: "5",
  vi: "6", vii: "7", viii: "8", ix: "9", x: "10",
};

/**
 * Normalise one token: lowercase, map standalone roman numerals to digits so
 * "mk II" and "mk 2" unify, and strip a trailing plural "s".
 */
export function normToken(raw: string): string {
  const t = raw.toLowerCase();
  if (ROMAN[t]) return ROMAN[t];
  if (t.length > 3 && t.endsWith("s")) return t.slice(0, -1);
  return t;
}

/** Tokenise a product/listing name into meaningful, variant-preserving tokens. */
export function tokenize(str: string): Set<string> {
  const out = new Set<string>();
  for (const raw of str.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < 1) continue;
    const t = normToken(raw);
    if (!t || STOP.has(t)) continue;
    // Single letters are almost always noise ("a", "x") EXCEPT digits.
    if (t.length === 1 && !/^[0-9]$/.test(t)) continue;
    out.add(t);
  }
  return out;
}

export interface NameMatch<T> {
  item: T;
  /** Jaccard similarity, 0..1. */
  score: number;
  /** Fraction of the QUERY's tokens found in the candidate, 0..1. */
  coverage: number;
  /** Query tokens the candidate does NOT have — the discriminating misses. */
  missing: string[];
}

/**
 * Rank candidates against a query name.
 *
 * Scoring is Jaccard (|A∩B| / |A∪B|) rather than raw coverage, specifically so
 * that a long bundle listing cannot win by accidentally containing the query's
 * tokens among a dozen unrelated ones.
 */
export function rankByName<T>(
  query: string,
  candidates: T[],
  nameOf: (c: T) => string,
  aliasesOf?: (c: T) => string[],
): Array<NameMatch<T>> {
  const q = tokenize(query);
  if (q.size === 0) return [];

  const out: Array<NameMatch<T>> = [];
  for (const c of candidates) {
    // Score against the canonical name AND each alias; keep the best.
    const surfaces = [nameOf(c), ...(aliasesOf ? aliasesOf(c) : [])];
    let best: NameMatch<T> | null = null;
    for (const surface of surfaces) {
      if (!surface) continue;
      const t = tokenize(surface);
      if (t.size === 0) continue;
      let inter = 0;
      const missing: string[] = [];
      for (const tok of q) {
        if (t.has(tok)) inter++;
        else missing.push(tok);
      }
      if (inter === 0) continue;
      const union = q.size + t.size - inter;
      const score = union > 0 ? inter / union : 0;
      const coverage = inter / q.size;
      if (!best || score > best.score) best = { item: c, score, coverage, missing };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score || b.coverage - a.coverage);
}

/**
 * Best single match, with a confidence gate.
 *
 * `confident` requires that EVERY query token was found (coverage === 1) AND
 * that no OTHER candidate also fully contains the query.
 *
 * The second condition is the important one, and it is about UNDER-specified
 * queries rather than ties: "BMPCC 6K" is fully contained by both "BMPCC 6K
 * Pro" and "BMPCC 6K Full Frame". Jaccard alone picks the shorter name as a
 * winner (fewer extra tokens), which would silently choose a body the renter
 * never specified. Two full-coverage candidates means the renter has not said
 * which one they mean — the caller must ASK, not guess.
 */
export function bestMatch<T>(
  query: string,
  candidates: T[],
  nameOf: (c: T) => string,
  aliasesOf?: (c: T) => string[],
): { match: T | null; confident: boolean; ambiguousWith: T[]; score: number } {
  const ranked = rankByName(query, candidates, nameOf, aliasesOf);
  if (ranked.length === 0) return { match: null, confident: false, ambiguousWith: [], score: 0 };
  const top = ranked[0];
  // Every candidate the query fully describes — if there is more than one, the
  // query is a prefix and cannot pick between them.
  const fullyCovered = ranked.filter((r) => r.coverage === 1);
  const rivals = fullyCovered.filter((r) => r.item !== top.item);
  const confident = top.coverage === 1 && rivals.length === 0;
  return {
    match: top.item,
    confident,
    ambiguousWith: rivals.map((t) => t.item),
    score: top.score,
  };
}

/**
 * How closely two OWNED items substitute for each other, for recommendations.
 * Higher is a better substitute. Used to stop a Blackmagic cinema body being
 * "replaced" by a Sony mirrorless just because both are kind=camera.
 */
export function substitutionScore(
  target: { name: string; kind?: string | null; lens_mount?: string | null },
  candidate: { name: string; kind?: string | null; lens_mount?: string | null },
): number {
  let s = 0;
  // Same category is the floor requirement.
  if (target.kind && candidate.kind && target.kind === candidate.kind) s += 3;
  // Same lens mount means their existing glass still fits — very high value.
  if (target.lens_mount && candidate.lens_mount && target.lens_mount === candidate.lens_mount) s += 4;
  // Shared brand/family tokens (BMPCC↔BMPCC, Sony↔Sony) — the strongest
  // signal that it "feels like" the same product line to the renter.
  const a = tokenize(target.name);
  const b = tokenize(candidate.name);
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  s += shared * 2;
  return s;
}

/**
 * Reduce a lens-mount string to its distinctive token so two spellings of the
 * same mount compare equal.
 *
 * Inventory is not consistent about this: the BMPCC 6K Pro records
 * "Canon EF mount" while adapters and lenses use "EF". An exact string
 * comparison therefore said the body's mount and the adapter's mount were
 * different things, so the bot was never shown the PL-to-EF adapter we stock
 * and told a renter we did not have it.
 *
 *   "Canon EF mount" -> "ef"      "EF" -> "ef"
 *   "Sony E mount"   -> "e"       "Leica L" -> "l"
 */
export function normalizeMount(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/\b(canon|leica|sony|nikon|fujifilm|fuji|panasonic|blackmagic|arri)\b/g, " ")
    .replace(/\b(mount|lens|bayonet)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Do two mount strings refer to the same mount? Empty on either side = unknown, so no claim. */
export function sameMount(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeMount(a);
  const y = normalizeMount(b);
  return !!x && !!y && x === y;
}

/**
 * Category words that name a KIND of gear, not a product.
 *
 * A request built only from these ("a lens", "a mic", "something wide") does
 * not identify anything, and must never be resolved to a specific item. Live:
 * "a lens" matched "DZOFilm Vespid 3-Lens Set" through the coverage gate,
 * because the single query token "lens" was fully covered — so a £20/day
 * 3-lens set was silently added to a booking nobody asked for.
 */
// NOTE: run through tokenize() below, because tokenize STEMS ("lens" -> "len").
// Hand-writing the surface forms silently failed to match: "a lens" sailed
// past this guard and added a 3-lens set.
const GENERIC_ITEM_WORDS_RAW = [
  "lens", "lense", "lenses", "glass", "camera", "cameras", "body", "bodies",
  "mic", "mics", "microphone", "microphones", "audio", "sound", "light",
  "lights", "lighting", "adapter", "adaptor", "mount", "battery", "batteries",
  "card", "cards", "storage", "gimbal", "stabiliser", "stabilizer", "drone",
  "monitor", "screen", "tripod", "stand", "rig", "cage", "bag", "case", "kit",
  "set", "gear", "equipment", "something", "anything", "one", "another",
  "extra", "spare", "wide", "long", "zoom", "prime", "cheap", "good", "best",
];
const GENERIC_ITEM_WORDS = new Set(
  GENERIC_ITEM_WORDS_RAW.flatMap((w) => [...tokenize(w)]),
);

/**
 * True when a request names only a category and no actual product, so it
 * cannot be resolved to one item and the renter must be asked which they mean.
 */
export function isGenericItemQuery(raw: string): boolean {
  const toks = [...tokenize(raw)];
  if (toks.length === 0) return true;
  return toks.every((t: string) => GENERIC_ITEM_WORDS.has(t));
}
