/**
 * catalog-sync.map — pure mapping + fuzzy-match helpers for the Phase 3
 * marketing-listings sync. Extracted from catalog-sync.ts so they can be unit
 * tested WITHOUT importing the Trigger SDK / Convex client. No I/O here.
 */

import type { Id } from "../../convex/_generated/dataModel";
import type {
  HyggloProductListItem,
  HyggloProductDetail,
  HyggloProductImage,
  HyggloProductPrice,
  HyggloProductListing,
} from "../hygglo-core/types";
import { findBestMatchWithScore } from "../../convex/lib/item_matcher";

/** Fuzzy-match acceptance threshold (coverage ratio). Mirrors
 *  derive-listing-info-pool.ts RESOLUTION_THRESHOLD. */
export const MATCH_THRESHOLD = 0.45;

/** Master inventory row, shaped for the fuzzy matcher. */
export interface InventoryRow {
  _id: Id<"items">;
  name: string; // name_canonical
  aliases: string[];
}

/** One product mapped to a `hygglo_products` upsert arg. */
export interface ProductUpsertArg {
  accountSlug: string;
  productId: number;
  name?: string;
  isPublished?: boolean;
  valuation?: number;
  minimumRentalDays?: number;
  prices?: HyggloProductListItem["prices"];
  images?: HyggloProductListItem["images"];
  unavailableDates?: unknown[];
  listings?: HyggloProductListItem["listings"];
  publicUrl?: string;
  masterItemId?: Id<"items">;
  isMarketingOnly: boolean;
  matchScore?: number;
}

/** Derive the best public URL for a product (top-level or first listing). */
export function publicUrlOf(p: HyggloProductListItem): string | undefined {
  if (p.publicUrl) return p.publicUrl;
  for (const l of p.listings ?? []) {
    if (l?.publicUrl) return l.publicUrl;
  }
  return undefined;
}

/** First listing slug — used as a fallback match phrase. */
export function slugOf(p: HyggloProductListItem): string | undefined {
  for (const l of p.listings ?? []) {
    if (l?.slug) return l.slug;
  }
  return undefined;
}

/**
 * Fuzzy-match a product against the master inventory. Tries the product name
 * first; if that misses the threshold, retries with the listing slug (dashes
 * → spaces). Returns the matched item id + score, or null when no confident
 * match exists.
 */
export function matchProduct(
  p: HyggloProductListItem,
  inventory: InventoryRow[],
  candidates: ReadonlyArray<{ name: string; aliases: string[] }>,
): { itemId: Id<"items">; score: number } | null {
  const phrases: string[] = [];
  if (p.name) phrases.push(p.name);
  const slug = slugOf(p);
  if (slug) phrases.push(slug.replace(/-/g, " "));

  let best: { itemId: Id<"items">; score: number } | null = null;
  for (const phrase of phrases) {
    if (!phrase.trim()) continue;
    const m = findBestMatchWithScore(phrase, candidates);
    if (!m || m.score < MATCH_THRESHOLD) continue;
    const found = inventory.find((i) => i.name === m.name);
    if (!found) continue;
    if (!best || m.score > best.score) {
      best = { itemId: found._id, score: m.score };
    }
  }
  return best;
}

/**
 * Build an object containing ONLY the listed `keys` whose value on `src` is
 * neither `null` nor `undefined`. This is the core of every catalog projection
 * and guards two distinct validator failures at once:
 *   1. Extra fields — keys not listed (e.g. `createdAt`/`updatedAt` that live
 *      Hygglo payloads ship) never make it into the result, so a strict
 *      `v.object` validator can't reject the row with "extra field …".
 *   2. Explicit `null` — `v.optional(v.number())` accepts the field being
 *      ABSENT but rejects an explicit `null` ("Value: null / Validator:
 *      v.float64()"). Live Hygglo prices send `price: null` on some tiers, so
 *      we omit any null/undefined key entirely rather than passing it through.
 * Result is drift-proof: no unexpected field and no null reaches the writer.
 */
function pickDefined<T extends object, K extends keyof T>(
  src: T,
  keys: readonly K[],
): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) {
    const val = src[k];
    if (val !== null && val !== undefined) out[k] = val;
  }
  return out;
}

/**
 * Project raw Hygglo image objects down to EXACTLY the six fields the
 * `hygglo_products` validator + schema accept (id, thumbnailUrl, fullSizeUrl,
 * filename, rotation, productId). Live Hygglo image payloads also carry
 * `createdAt`/`updatedAt` (and potentially other future fields) which the
 * strict Convex `imageArg` object validator rejects with an
 * `ArgumentValidationError` — that is what kept `hygglo_products` empty. Extra
 * fields AND explicit `null` values are stripped via {@link pickDefined} so the
 * writer never sees an unexpected field or a null where a number is expected.
 * Returns `undefined` for a non-array input so the optional field is omitted.
 */
const IMAGE_KEYS = [
  "id",
  "thumbnailUrl",
  "fullSizeUrl",
  "filename",
  "rotation",
  "productId",
] as const satisfies readonly (keyof HyggloProductImage)[];

export function projectImages(
  images: HyggloProductImage[] | undefined,
): HyggloProductImage[] | undefined {
  if (!Array.isArray(images)) return undefined;
  return images.map((im) => pickDefined(im, IMAGE_KEYS));
}

/**
 * Project raw Hygglo price objects down to EXACTLY the five fields the strict
 * Convex `priceArg`/schema `prices` object validator accepts (id, productId,
 * pricePerDay, days, price). Same drift hazard as {@link projectImages}: the
 * lean `HyggloProductPrice` type only declares the allowed keys, but live
 * `GET /v2/my/products` price payloads also ship `createdAt`/`updatedAt` (and
 * potentially future fields) that the strict object validator rejects with an
 * `ArgumentValidationError`. Stripping extras here keeps the writer drift-proof.
 * It also drops explicit `null`s: live Hygglo prices send `price: null` on some
 * tiers, and `v.optional(v.number())` rejects null (accepts only absence) —
 * that was the second prod failure ("Path: .products[0].prices[3].price /
 * Value: null"). {@link pickDefined} handles both extras and nulls. Returns
 * `undefined` for non-array input so the optional field is simply omitted.
 */
const PRICE_KEYS = [
  "id",
  "productId",
  "pricePerDay",
  "days",
  "price",
] as const satisfies readonly (keyof HyggloProductPrice)[];

export function projectPrices(
  prices: HyggloProductPrice[] | undefined,
): HyggloProductPrice[] | undefined {
  if (!Array.isArray(prices)) return undefined;
  return prices.map((pr) => pickDefined(pr, PRICE_KEYS));
}

/**
 * Project raw Hygglo listing objects down to EXACTLY the five fields the strict
 * Convex `listingArg`/schema `listings` object validator accepts (id, slug,
 * productId, publicUrl, location). This is the field that kept `hygglo_products`
 * empty AFTER the image fix shipped: live `listings[]` carry `createdAt` (and
 * other timestamps) which the strict object validator rejects with
 * `ArgumentValidationError: extra field createdAt ... .listings[0]`. `location`
 * is intentionally listed but `v.any()` accepts any nested shape, so a present
 * non-null location is passed through verbatim. Extra fields and explicit nulls
 * are stripped via {@link pickDefined}. Returns `undefined` for non-array input
 * so the optional field is simply omitted.
 */
const LISTING_KEYS = [
  "id",
  "slug",
  "productId",
  "publicUrl",
  "location",
] as const satisfies readonly (keyof HyggloProductListing)[];

export function projectListings(
  listings: HyggloProductListing[] | undefined,
): HyggloProductListing[] | undefined {
  if (!Array.isArray(listings)) return undefined;
  return listings.map((l) => pickDefined(l, LISTING_KEYS));
}

/** Map a (possibly detail-enriched) product to an upsert arg. */
export function toUpsertArg(
  accountSlug: string,
  list: HyggloProductListItem,
  detail: HyggloProductDetail | undefined,
  match: { itemId: Id<"items">; score: number } | null,
): ProductUpsertArg {
  const src: HyggloProductDetail | HyggloProductListItem = detail ?? list;
  const unavailableDates =
    detail && Array.isArray(detail.unavailableDates)
      ? (detail.unavailableDates as unknown[])
      : undefined;

  return {
    accountSlug,
    productId: list.id,
    name: src.name,
    isPublished: src.isPublished,
    valuation: src.valuation,
    minimumRentalDays: src.minimumRentalDays,
    prices: projectPrices(src.prices),
    images: projectImages(src.images),
    unavailableDates,
    listings: projectListings(src.listings),
    publicUrl: publicUrlOf(src),
    masterItemId: match?.itemId,
    isMarketingOnly: match === null,
    matchScore: match?.score,
  };
}

/** Build matcher candidates from inventory rows. */
export function buildCandidates(
  inventory: InventoryRow[],
): Array<{ name: string; aliases: string[] }> {
  return inventory.map((i) => ({ name: i.name, aliases: i.aliases }));
}
