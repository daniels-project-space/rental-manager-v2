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
 * Project raw Hygglo image objects down to EXACTLY the six fields the
 * `hygglo_products` validator + schema accept (id, thumbnailUrl, fullSizeUrl,
 * filename, rotation, productId). Live Hygglo image payloads also carry
 * `createdAt`/`updatedAt` (and potentially other future fields) which the
 * strict Convex `imageArg` object validator rejects with an
 * `ArgumentValidationError` — that is what kept `hygglo_products` empty. This
 * single, drift-proof projection strips any extras at the mapper boundary so
 * the writer never sees an unexpected field. Returns `undefined` for a
 * non-array input so the optional field is simply omitted.
 */
export function projectImages(
  images: HyggloProductImage[] | undefined,
): HyggloProductImage[] | undefined {
  if (!Array.isArray(images)) return undefined;
  return images.map((im) => ({
    id: im.id,
    thumbnailUrl: im.thumbnailUrl,
    fullSizeUrl: im.fullSizeUrl,
    filename: im.filename,
    rotation: im.rotation,
    productId: im.productId,
  }));
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
    prices: src.prices,
    images: projectImages(src.images),
    unavailableDates,
    listings: src.listings,
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
