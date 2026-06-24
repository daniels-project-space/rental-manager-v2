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
  | "bank"
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
 *   0. listing_images bank (account_slug, product_id)       -> 1.00, bank
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
  bankByProduct?: Map<string, string>;
  accountSlug?: string | null;
  productId?: number | null;
  /** The reservation's OWN representative photo (account-correct — a Hygglo
   *  per-item/order image from THIS reservation). Used before the GLOBAL
   *  items_table fallback so a shared canonical item can never bleed another
   *  account's photo onto this one (e.g. a Leo light showing a DB Cinema
   *  tripod). At worst shows another item from the same reservation/account. */
  ownAccountFallbackUrl?: string | null;
}): ResolvedImage {
  const {
    imageHints,
    itemName,
    itemsTableEntry,
    resolvedConfidence,
    sharedBlacklist,
    bankByProduct,
    accountSlug,
    productId,
    ownAccountFallbackUrl,
  } = args;

  // 0. listing_images bank — product_id-keyed canonical photo. Stable PK,
  //    immune to PASS-9 cross-rental name aliasing. Wins outright.
  if (
    bankByProduct &&
    accountSlug &&
    productId !== null &&
    productId !== undefined
  ) {
    const bankUrl = bankByProduct.get(`${accountSlug}#${productId}`);
    if (bankUrl) {
      return { url: bankUrl, source: "bank", confidence: 1.0 };
    }
  }

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

  // 3. Reservation's OWN account-correct photo — preferred over the GLOBAL
  //    items_table image below. `items` are shared canonical rows (no
  //    account_slug), so items_table.image_url is one photo per item across
  //    ALL accounts and is the root of cross-account image bleed. Falling back
  //    to the reservation's own Hygglo photo keeps the image account-correct.
  if (ownAccountFallbackUrl && !ownAccountFallbackUrl.includes("example.com")) {
    return { url: ownAccountFallbackUrl, source: "hint_normalised", confidence: 0.6 };
  }

  // 4. items_table fallback — GLOBAL/shared; only reached when the reservation
  //    has no own photo. Still gated by resolver confidence + shared-blacklist.
  const tableUrl = itemsTableEntry?.image_url ?? null;
  const conf = resolvedConfidence ?? 0;
  if (
    tableUrl &&
    conf >= MIN_RESOLVER_CONFIDENCE_FOR_ITEMS_TABLE &&
    !sharedBlacklist.has(basenameFromUrl(tableUrl))
  ) {
    return { url: tableUrl, source: "items_table", confidence: 0.7 };
  }

  // 5. Give up — UI placeholder.
  return { url: PLACEHOLDER_URL, source: "placeholder", confidence: 0 };
}

/**
 * Pick the single representative item for a reservation so its NAME and IMAGE
 * always agree (the historical bug was master_image_url coming from item[0]
 * while the displayed name came from a different item, or vice-versa).
 *
 * Algorithm:
 *   - iterate `items` IN ORDER
 *   - resolve each via the supplied `resolve` callback (the caller owns the
 *     productId / accountSlug / itemsTableEntry wiring — this module stays
 *     DB-free and pure)
 *   - return the FIRST item whose resolved `source !== "placeholder"`
 *   - tie-break by item order (first wins — guaranteed by the in-order scan)
 *   - if EVERY item is a placeholder, fall back to items[0] (name still shown,
 *     imageUrl null so the UI renders its per-item abbreviation tile)
 *
 * Returns `{ name, imageUrl, source, productId }` so callers can set both the
 * master image and the alt/name from a SINGLE source of truth. `productId` is
 * echoed back from the chosen item descriptor for downstream use.
 *
 * IMPORTANT: callers MUST branch on `source`, NOT on a truthy `imageUrl` —
 * the placeholder tier can return a non-null sentinel url depending on
 * PLACEHOLDER_URL configuration.
 */
export function pickRepresentativeItem<
  T extends { name: string; productId?: number | null },
>(
  items: T[],
  resolve: (item: T) => ResolvedImage,
): { name: string; imageUrl: string | null; source: ResolvedImageSource; productId: number | null } {
  if (!items || items.length === 0) {
    return { name: "", imageUrl: null, source: "placeholder", productId: null };
  }
  for (const it of items) {
    const res = resolve(it);
    if (res.source !== "placeholder") {
      return {
        name: it.name,
        imageUrl: res.url,
        source: res.source,
        productId: it.productId ?? null,
      };
    }
  }
  // All placeholders — fall back to the first item (name shown, no image).
  const first = items[0];
  const firstRes = resolve(first);
  return {
    name: first.name,
    imageUrl: firstRes.url,
    source: firstRes.source,
    productId: first.productId ?? null,
  };
}
