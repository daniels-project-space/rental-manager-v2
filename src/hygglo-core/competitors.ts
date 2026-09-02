/**
 * hygglo-core/competitors — competitor-intel reads (additive, read-only).
 *
 * Pulls a LIMITED, PII-SAFE sample of a competitor vendor's public rental
 * history (via reviews) and current listings (for price hints). Used by the
 * one-time ingest script `scripts/ingest-competitor-intel.mjs` and nothing on
 * the live poll path.
 *
 * Endpoints (public — `requireAuth:false`, also visible on hygglo.com):
 *   - Reviews : GET /v4/product-reviews?vendorId={id}&$limit=100&$skip=0
 *               envelope { limit, skip, total, data[] }, each row
 *               { rating, createdAt, product:{name}, productListing:{slug} }.
 *   - Listings: GET /v4/product-listings/search?vendorId={id}&pageSize=100&pageIndex=0
 *               envelope { productListings[], totalCount, hasNextPage, ... }.
 *
 * ── PII FIREWALL (hard) ──────────────────────────────────────────────
 * The mappers below extract ONLY {item name, date, rating} from reviews and
 * {item name, daily price, slug} from listings. Reviewer names and review
 * text are NEVER read, returned, stored, or logged. The raw response objects
 * never leave this module — only the firewalled shapes are returned.
 *
 * Read-only: uses `client.getPublicJson` (no Bearer, no mutation surface).
 * `getPublicJson` auto-appends `&country=GB`, so paths omit `country`.
 */

import { HYGGLO_API_VERSION } from "./auth";
import type { HyggloClient } from "./client";

/** PII-safe review fact: which item, when, what rating + the listing ref
 *  (numeric id + slug) so a price can be resolved from the public listing
 *  detail. NO author/text. */
export interface CompetitorReviewFact {
  item: string;
  date: string; // ISO createdAt
  rating: number | null;
  listingId: number | null;
  slug: string | null;
}

/** PII-safe listing fact: which item, daily price (GBP), slug, listing id. */
export interface CompetitorListingFact {
  item: string;
  slug: string | null;
  listingId: number | null;
  dailyPrice: number | null;
}

// ── Raw response shapes (kept local; only the firewalled subset is read) ──
interface RawReviewsEnvelope {
  limit?: number;
  skip?: number;
  total?: number | null;
  data?: Array<{
    rating?: number | null;
    createdAt?: string;
    // NOTE: the wire row also carries `author` + `text` — deliberately NOT
    // typed/read here (PII firewall). Only name/date/rating/listing-ref used.
    product?: { name?: string } | null;
    productListing?: { id?: number; slug?: string } | null;
  }>;
}

// Public listing-detail shape (price source). `GET /v4/product-listings/{id}`.
interface RawListingDetail {
  id?: number;
  slug?: string;
  product?: {
    name?: string;
    // prices[] = per-duration tiers; `days:1` is the true single-day rate.
    prices?: Array<{
      days?: number | null;
      pricePerDay?: number | null;
      price?: number | null;
    }> | null;
    highestPricePerDay?: number | null;
    lowestPricePerDay?: number | null;
  } | null;
}

interface RawListingsEnvelope {
  productListings?: RawListing[];
  // some envelope variants nest under `data` — handled by `asListingArray`.
  data?: RawListing[];
  totalCount?: number;
  hasNextPage?: boolean;
}

interface RawListing {
  id?: number;
  // The listing search response carries the item name + price on `product`.
  product?: {
    name?: string;
    // price shapes vary; we inspect all known fields and take the first hit.
    prices?: Array<{ pricePerDay?: number | null; price?: number | null }> | null;
    lowestPricePerDay?: number | null;
    priceRange?: { min?: number | null; from?: number | null } | null;
  } | null;
  // some variants surface the fields at the top level instead of on product.
  name?: string;
  title?: string;
  slug?: string;
  prices?: Array<{ pricePerDay?: number | null; price?: number | null }> | null;
  lowestPricePerDay?: number | null;
  dailyPrice?: number | null;
  priceRange?: { min?: number | null; from?: number | null } | null;
}

/**
 * Pull a LIMITED sample of a vendor's reviews → PII-safe item/date/rating
 * facts. Defaults to exactly one page of 100 (`$limit=100&$skip=0`) — the
 * sampling bound for the competitor-intel feature. No pagination by default
 * (deliberately a single bounded sample, not a bulk harvest).
 */
export async function getVendorReviews(
  client: HyggloClient,
  vendorId: number | string,
  opts: { limit?: number; skip?: number } = {},
): Promise<CompetitorReviewFact[]> {
  const limit = opts.limit ?? 100;
  const skip = opts.skip ?? 0;
  const env = await client.getPublicJson<RawReviewsEnvelope>(
    `/${HYGGLO_API_VERSION}/product-reviews?vendorId=${encodeURIComponent(String(vendorId))}` +
      `&$limit=${limit}&$skip=${skip}`,
  );
  const rows = Array.isArray(env?.data) ? env.data : [];
  const out: CompetitorReviewFact[] = [];
  for (const r of rows) {
    const item = r?.product?.name?.trim();
    const date = r?.createdAt;
    if (!item || !date) continue; // skip rows with no usable item/date
    const lid = r?.productListing?.id;
    out.push({
      item,
      date,
      rating: typeof r?.rating === "number" ? r.rating : null,
      listingId: typeof lid === "number" ? lid : null,
      slug: r?.productListing?.slug ?? null,
    });
  }
  return out;
}

/**
 * Resolve the daily price (GBP) for ONE listing via the public listing-detail
 * endpoint `GET /v4/product-listings/{id}` (200, no Bearer). Returns the true
 * single-day rate (`prices[].days===1`), falling back to highest/lowest per-day
 * or the first positive per-day tier. Read-only, PII-safe (no owner/reviewer
 * data read). Returns null if the listing has no usable price or 404s.
 */
export async function getListingPrice(
  client: HyggloClient,
  listingId: number | string,
): Promise<CompetitorListingFact | null> {
  let detail: RawListingDetail;
  try {
    detail = await client.getPublicJson<RawListingDetail>(
      `/${HYGGLO_API_VERSION}/product-listings/${encodeURIComponent(String(listingId))}`,
    );
  } catch {
    return null; // 404 / removed listing — treat as no price
  }
  const p = detail?.product ?? null;
  const item = p?.name?.trim();
  if (!item) return null;

  let dailyPrice: number | null = null;
  const tiers = Array.isArray(p?.prices) ? p!.prices! : [];
  // Prefer the explicit 1-day tier (true single-rental rate).
  const oneDay = tiers.find((t) => t?.days === 1);
  const oneDayVal = oneDay?.pricePerDay ?? oneDay?.price;
  if (typeof oneDayVal === "number" && oneDayVal > 0) {
    dailyPrice = oneDayVal;
  } else if (typeof p?.highestPricePerDay === "number" && p.highestPricePerDay > 0) {
    dailyPrice = p.highestPricePerDay;
  } else if (typeof p?.lowestPricePerDay === "number" && p.lowestPricePerDay > 0) {
    dailyPrice = p.lowestPricePerDay;
  } else {
    for (const t of tiers) {
      const v = t?.pricePerDay ?? t?.price;
      if (typeof v === "number" && v > 0) {
        dailyPrice = v;
        break;
      }
    }
  }

  return {
    item,
    slug: detail?.slug ?? null,
    listingId: typeof detail?.id === "number" ? detail.id : Number(listingId),
    dailyPrice,
  };
}

/** Normalise the listings envelope: prefer `productListings`, fall back to `data`. */
function asListingArray(env: RawListingsEnvelope | undefined): RawListing[] {
  if (Array.isArray(env?.productListings)) return env.productListings;
  if (Array.isArray(env?.data)) return env.data;
  return [];
}

/**
 * Inspect the (variable) price shape and return a daily price in GBP, or null.
 * Order of preference: explicit per-day arrays → lowestPricePerDay →
 * dailyPrice → priceRange.min/from. Inspecting `product.*` and top-level both.
 */
function extractDailyPrice(l: RawListing): number | null {
  const p = l?.product ?? null;
  const fromArray = (
    arr?: Array<{ pricePerDay?: number | null; price?: number | null }> | null,
  ): number | null => {
    if (!Array.isArray(arr)) return null;
    for (const e of arr) {
      const v = e?.pricePerDay ?? e?.price;
      if (typeof v === "number" && v > 0) return v;
    }
    return null;
  };

  const candidates: Array<number | null | undefined> = [
    fromArray(p?.prices),
    p?.lowestPricePerDay,
    fromArray(l?.prices),
    l?.lowestPricePerDay,
    l?.dailyPrice,
    p?.priceRange?.min,
    p?.priceRange?.from,
    l?.priceRange?.min,
    l?.priceRange?.from,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && c > 0) return c;
  }
  return null;
}

/**
 * Pull a vendor's current listings via the search endpoint → PII-safe
 * {item, slug, listingId, dailyPrice} facts. One page of up to 100.
 *
 * NOTE: empirically (2026-06-04) the public `search?vendorId=`/`ownerId=`
 * returns 0 rows for the competitor vendors even though their reviews resolve,
 * so the ingest resolves prices via `getListingPrice` on the listing ids found
 * in the reviews instead. This function is retained as a secondary price source
 * (and used where vendor search DOES return rows).
 */
export async function getVendorListings(
  client: HyggloClient,
  vendorId: number | string,
  opts: { pageSize?: number; pageIndex?: number } = {},
): Promise<CompetitorListingFact[]> {
  const pageSize = opts.pageSize ?? 100;
  const pageIndex = opts.pageIndex ?? 0;
  const env = await client.getPublicJson<RawListingsEnvelope>(
    `/${HYGGLO_API_VERSION}/product-listings/search?vendorId=${encodeURIComponent(String(vendorId))}` +
      `&pageSize=${pageSize}&pageIndex=${pageIndex}`,
  );
  const rows = asListingArray(env);
  const out: CompetitorListingFact[] = [];
  for (const l of rows) {
    const item = (l?.product?.name ?? l?.name ?? l?.title)?.trim();
    if (!item) continue;
    out.push({
      item,
      slug: l?.slug ?? null,
      listingId: typeof l?.id === "number" ? l.id : null,
      dailyPrice: extractDailyPrice(l),
    });
  }
  return out;
}
