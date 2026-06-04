/**
 * hygglo-core/competitor-aggregate — pure aggregation of competitor review +
 * listing facts into the PII-safe per-item rollup the dashboard shows.
 *
 * Pure (no I/O) so it is unit-testable and shared by the ingest script. Takes
 * the firewalled facts from `competitors.ts` (which already stripped reviewer
 * names/text) and produces one row per distinct item name, merged across all
 * sampled vendors.
 *
 * Revenue model (rough estimate — documented assumption):
 *   estRevenueGbp = rentalCount × dailyPriceGbp × OWNER_SHARE
 *   "1 review ≈ 1 day rental at current list price; rough estimate."
 * where OWNER_SHARE is the owner take-home fraction after ~36% platform fees.
 * Items with no matched list price → estRevenue 0 (counted as unmatched).
 */
import type {
  CompetitorReviewFact,
  CompetitorListingFact,
} from "./competitors";

/** Owner take-home after platform fees. Mirrors the canonical
 *  `convex/lib/revenue_attribution.ts` OWNER_SHARE (0.64). Re-declared here
 *  (not imported) so this pure module stays free of any Convex import. */
export const COMPETITOR_OWNER_SHARE = 0.64;

export interface AggregatedItem {
  itemName: string;
  vendorIds: string[];
  rentalCount: number;
  lastRentedAt: string; // ISO (max createdAt)
  avgRating?: number;
  dailyPriceGbp?: number;
  estRevenueGbp: number;
}

export interface AggregateResult {
  items: AggregatedItem[];
  reviewsSampled: number;
  vendorsCount: number;
  unmatchedPriceCount: number;
}

/** Normalise an item name for matching (case/space-insensitive). */
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Build a price lookup from listing facts, keyed by normalised item name AND
 * slug. Last non-null price wins (listings are a current snapshot).
 */
function buildPriceIndex(
  listingsByVendor: Array<{ vendorId: string; listings: CompetitorListingFact[] }>,
): {
  byName: Map<string, number>;
  bySlug: Map<string, number>;
  byListingId: Map<number, number>;
} {
  const byName = new Map<string, number>();
  const bySlug = new Map<string, number>();
  const byListingId = new Map<number, number>();
  for (const { listings } of listingsByVendor) {
    for (const l of listings) {
      if (typeof l.dailyPrice === "number" && l.dailyPrice > 0) {
        byName.set(norm(l.item), l.dailyPrice);
        if (l.slug) bySlug.set(l.slug, l.dailyPrice);
        if (typeof l.listingId === "number")
          byListingId.set(l.listingId, l.dailyPrice);
      }
    }
  }
  return { byName, bySlug, byListingId };
}

/**
 * Aggregate review + listing facts (per vendor) into merged per-item rows.
 *
 * @param reviewsByVendor  firewalled review facts grouped by vendorId
 * @param listingsByVendor firewalled listing facts grouped by vendorId
 */
export function aggregateCompetitorIntel(
  reviewsByVendor: Array<{ vendorId: string; reviews: CompetitorReviewFact[] }>,
  listingsByVendor: Array<{ vendorId: string; listings: CompetitorListingFact[] }>,
): AggregateResult {
  const { byName, bySlug, byListingId } = buildPriceIndex(listingsByVendor);

  // Accumulate per distinct (normalised) item name.
  interface Acc {
    itemName: string; // display name (first seen)
    vendorIds: Set<string>;
    rentalCount: number;
    lastRentedAt: string;
    ratingSum: number;
    ratingN: number;
    listingIds: Set<number>; // listing ids seen for this item (price lookup)
    slugs: Set<string>;
  }
  const acc = new Map<string, Acc>();
  let reviewsSampled = 0;

  for (const { vendorId, reviews } of reviewsByVendor) {
    for (const r of reviews) {
      reviewsSampled++;
      const key = norm(r.item);
      let a = acc.get(key);
      if (!a) {
        a = {
          itemName: r.item.trim(),
          vendorIds: new Set(),
          rentalCount: 0,
          lastRentedAt: r.date,
          ratingSum: 0,
          ratingN: 0,
          listingIds: new Set(),
          slugs: new Set(),
        };
        acc.set(key, a);
      }
      a.vendorIds.add(vendorId);
      a.rentalCount += 1;
      if (r.date > a.lastRentedAt) a.lastRentedAt = r.date;
      if (typeof r.rating === "number") {
        a.ratingSum += r.rating;
        a.ratingN += 1;
      }
      if (typeof r.listingId === "number") a.listingIds.add(r.listingId);
      if (r.slug) a.slugs.add(r.slug);
    }
  }

  let unmatchedPriceCount = 0;
  const items: AggregatedItem[] = [];
  for (const [key, a] of acc) {
    // Price match order: listing id (most precise) → slug → item name.
    let dailyPriceGbp: number | undefined;
    for (const lid of a.listingIds) {
      const p = byListingId.get(lid);
      if (typeof p === "number") {
        dailyPriceGbp = p;
        break;
      }
    }
    if (dailyPriceGbp === undefined) {
      for (const s of a.slugs) {
        const p = bySlug.get(s);
        if (typeof p === "number") {
          dailyPriceGbp = p;
          break;
        }
      }
    }
    if (dailyPriceGbp === undefined) dailyPriceGbp = byName.get(key);
    const avgRating = a.ratingN > 0 ? a.ratingSum / a.ratingN : undefined;
    // estRevenueGbp = rentalCount × dailyPriceGbp × OWNER_SHARE.
    // 1 review ≈ 1 day rental at current list price; rough estimate.
    const estRevenueGbp =
      typeof dailyPriceGbp === "number"
        ? a.rentalCount * dailyPriceGbp * COMPETITOR_OWNER_SHARE
        : 0;
    if (typeof dailyPriceGbp !== "number") unmatchedPriceCount++;
    items.push({
      itemName: a.itemName,
      vendorIds: Array.from(a.vendorIds),
      rentalCount: a.rentalCount,
      lastRentedAt: a.lastRentedAt,
      avgRating,
      dailyPriceGbp,
      estRevenueGbp: Math.round(estRevenueGbp * 100) / 100,
    });
  }

  // Sort by estimated revenue desc, then rental count desc.
  items.sort((x, y) =>
    y.estRevenueGbp !== x.estRevenueGbp
      ? y.estRevenueGbp - x.estRevenueGbp
      : y.rentalCount - x.rentalCount,
  );

  const vendorIds = new Set<string>();
  for (const { vendorId } of reviewsByVendor) vendorIds.add(vendorId);

  return {
    items,
    reviewsSampled,
    vendorsCount: vendorIds.size,
    unmatchedPriceCount,
  };
}
