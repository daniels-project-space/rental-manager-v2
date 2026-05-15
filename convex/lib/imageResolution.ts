/**
 * Image-resolution helpers shared by all dashboard widget queries.
 *
 * Pure functions only — NO Convex DB access. All inputs are passed in by the
 * caller, so this module is trivially unit-testable and reusable from
 * `dashboard.ts`, `calendar.ts`, etc.
 *
 * Per FIX-DESIGN.md sections 3 and 4.3 (Phase 5).
 */

export type ImageHint = {
  item_name: string;
  item_name_normalised: string;
  image_url: string;
  source: "hygglo_per_item" | "hygglo_order" | "manual_override";
};

export type ResolvedImageSource =
  | "hint_exact"
  | "hint_normalised"
  | "items_table"
  | "placeholder";

export interface ResolvedImage {
  url: string | null;
  source: ResolvedImageSource;
  confidence: number; // 1.0 hint_exact, 0.95 hint_normalised, 0.7 items_table, 0 placeholder
}

const PLACEHOLDER_URL: string | null = null;
const MIN_RESOLVER_CONFIDENCE_FOR_ITEMS_TABLE = 0.8;

/**
 * Stable normalisation for item-name comparisons.
 *
 * Steps:
 *   1. lowercase
 *   2. strip leading multiplier prefixes like "2x ", "3x ", "10X "
 *   3. collapse `[\s\-_/]+` to a single space
 *   4. trim
 */
export function normaliseItemName(s: string): string {
  if (!s) return "";
  let out = s.toLowerCase();
  // Strip leading "2x ", "3x ", "10x ", etc. (with or without trailing space)
  out = out.replace(/^\s*\d+\s*x\s+/u, "");
  out = out.replace(/[\s\-_/]+/gu, " ");
  return out.trim();
}

/**
 * Extract the basename of a URL, stripping the query string.
 * Returns the original input when parsing fails (defensive — never throws).
 */
export function basenameFromUrl(u: string): string {
  if (!u) return "";
  // Strip query + fragment first.
  const noQuery = u.split("?")[0].split("#")[0];
  // Take the segment after the last '/'.
  const idx = noQuery.lastIndexOf("/");
  return idx >= 0 ? noQuery.slice(idx + 1) : noQuery;
}

/**
 * Build a Set of `image_url` basenames that appear on >=2 distinct items in
 * the global `items` table. Used as a guard against the historical bug where
 * the first reservation's first photo got pinned to multiple inventory items.
 *
 * Distinctness is per-item-row: callers should pass the full `items` collection;
 * basenames repeated across two or more rows are blacklisted.
 */
export function buildSharedImageBlacklist(
  itemsTable: Array<{ image_url?: string | null }>,
): Set<string> {
  const counts = new Map<string, number>();
  for (const it of itemsTable) {
    const u = it.image_url;
    if (!u) continue;
    const key = basenameFromUrl(u);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const shared = new Set<string>();
  for (const [k, n] of counts.entries()) {
    if (n >= 2) shared.add(k);
  }
  return shared;
}

/**
 * Resolve a rendering image for one (reservation, item) pair.
 *
 * Resolution order (first hit wins):
 *   1. `imageHints` exact match on `item_name`              -> 1.00, hint_exact
 *   2. `imageHints` match on normalised name                -> 0.95, hint_normalised
 *   3. `itemsTableEntry.image_url` IF resolverConfidence>=0.8
 *      AND basename(URL) NOT in `sharedBlacklist`           -> 0.70, items_table
 *   4. placeholder (UI renders fallback SVG)                -> 0.00, placeholder
 */
export function resolveImageForReservationItem(args: {
  imageHints: ImageHint[];
  itemName: string;
  itemsTableEntry?: { image_url?: string | null } | null;
  resolvedConfidence?: number | null;
  sharedBlacklist: Set<string>;
}): ResolvedImage {
  const {
    imageHints,
    itemName,
    itemsTableEntry,
    resolvedConfidence,
    sharedBlacklist,
  } = args;

  // 1. Exact item_name match.
  const exact = imageHints.find((h) => h.item_name === itemName);
  if (exact) {
    return { url: exact.image_url, source: "hint_exact", confidence: 1.0 };
  }

  // 2. Normalised match.
  const norm = normaliseItemName(itemName);
  if (norm) {
    const fuzzy = imageHints.find((h) => h.item_name_normalised === norm);
    if (fuzzy) {
      return { url: fuzzy.image_url, source: "hint_normalised", confidence: 0.95 };
    }
  }

  // 3. items_table fallback — only when resolver is confident AND URL is not
  //    in the shared-blacklist (basename-based to dodge query-string drift).
  const tableUrl = itemsTableEntry?.image_url ?? null;
  const conf = resolvedConfidence ?? 0;
  if (
    tableUrl &&
    conf >= MIN_RESOLVER_CONFIDENCE_FOR_ITEMS_TABLE &&
    !sharedBlacklist.has(basenameFromUrl(tableUrl))
  ) {
    return { url: tableUrl, source: "items_table", confidence: 0.7 };
  }

  // 4. Give up — UI placeholder.
  return { url: PLACEHOLDER_URL, source: "placeholder", confidence: 0 };
}
