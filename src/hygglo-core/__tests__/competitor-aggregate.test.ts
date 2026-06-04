/**
 * Unit tests for competitor-intel aggregation + revenue math.
 *
 * Exercises the REAL `aggregateCompetitorIntel` on hand-built firewalled facts
 * (the shape `competitors.ts` returns). No mocks of the unit under test; every
 * assertion pins a value derivable only if merge + price-match + revenue math
 * are correct. estRevenue = rentalCount × dailyPrice × OWNER_SHARE(0.64).
 */
import { describe, it, expect } from "vitest";
import {
  aggregateCompetitorIntel,
  COMPETITOR_OWNER_SHARE,
} from "../competitor-aggregate";
import type {
  CompetitorReviewFact,
  CompetitorListingFact,
} from "../competitors";

// Builders so tests stay terse while satisfying the full firewalled shapes.
const rev = (
  item: string,
  date: string,
  rating: number | null,
  listingId: number | null = null,
  slug: string | null = null,
): CompetitorReviewFact => ({ item, date, rating, listingId, slug });

const lst = (
  item: string,
  dailyPrice: number | null,
  slug: string | null = null,
  listingId: number | null = null,
): CompetitorListingFact => ({ item, dailyPrice, slug, listingId });

describe("aggregateCompetitorIntel", () => {
  it("OWNER_SHARE matches the canonical 0.64 take-home", () => {
    expect(COMPETITOR_OWNER_SHARE).toBe(0.64);
  });

  it("merges the same item across two vendors, sums rentals, takes max date, matches price by name, computes revenue", () => {
    const reviewsByVendor = [
      {
        vendorId: "111",
        reviews: [
          rev("Sony FX6", "2026-01-01T00:00:00Z", 5),
          rev("sony fx6", "2026-03-01T00:00:00Z", 4), // case-insensitive merge
        ],
      },
      {
        vendorId: "222",
        reviews: [
          rev("Sony FX6", "2026-02-01T00:00:00Z", 3),
          rev("DJI Mic", "2026-02-15T00:00:00Z", null),
        ],
      },
    ];
    const listingsByVendor = [
      { vendorId: "111", listings: [lst("Sony FX6", 100, "sony-fx6")] },
      { vendorId: "222", listings: [lst("DJI Mic", null)] }, // unmatched price
    ];

    const res = aggregateCompetitorIntel(reviewsByVendor, listingsByVendor);

    expect(res.reviewsSampled).toBe(4);
    expect(res.vendorsCount).toBe(2);
    // FX6 appears under both vendors → unmatched=1 (DJI Mic only).
    expect(res.unmatchedPriceCount).toBe(1);

    const fx6 = res.items.find((i) => i.itemName === "Sony FX6")!;
    expect(fx6).toBeTruthy();
    expect(fx6.rentalCount).toBe(3); // 2 from v111 + 1 from v222
    expect(fx6.vendorIds.sort()).toEqual(["111", "222"]);
    expect(fx6.lastRentedAt).toBe("2026-03-01T00:00:00Z"); // max date
    expect(fx6.avgRating).toBeCloseTo((5 + 4 + 3) / 3, 5);
    expect(fx6.dailyPriceGbp).toBe(100);
    // 3 × 100 × 0.64 = 192
    expect(fx6.estRevenueGbp).toBe(192);

    const mic = res.items.find((i) => i.itemName === "DJI Mic")!;
    expect(mic.rentalCount).toBe(1);
    expect(mic.dailyPriceGbp).toBeUndefined();
    expect(mic.estRevenueGbp).toBe(0); // no price → 0
    expect(mic.avgRating).toBeUndefined(); // no usable ratings
  });

  it("matches price by listing id (preferred over name) — mirrors the real ingest path", () => {
    const reviewsByVendor = [
      {
        vendorId: "1",
        reviews: [
          // Same item, two listing ids; price comes from the listing-detail map.
          rev("Camera", "2026-01-01T00:00:00Z", 5, 1592322),
          rev("Camera", "2026-01-02T00:00:00Z", 5, 1592322),
        ],
      },
    ];
    // Listing-detail facts (what getListingPrice returns): price keyed by id.
    const listingsByVendor = [
      { vendorId: "1", listings: [lst("Camera detail name differs", 50, null, 1592322)] },
    ];
    const res = aggregateCompetitorIntel(reviewsByVendor, listingsByVendor);
    const cam = res.items[0];
    expect(cam.itemName).toBe("Camera"); // review name wins for display
    expect(cam.dailyPriceGbp).toBe(50); // matched by listing id, not name
    expect(res.unmatchedPriceCount).toBe(0);
    // 2 × 50 × 0.64 = 64
    expect(cam.estRevenueGbp).toBe(64);
  });

  it("sorts by est revenue desc then rental count, rounds revenue to 2dp", () => {
    const reviewsByVendor = [
      {
        vendorId: "1",
        reviews: [
          rev("Cheap", "2026-01-01T00:00:00Z", 5),
          rev("Cheap", "2026-01-02T00:00:00Z", 5),
          rev("Pricey", "2026-01-03T00:00:00Z", 5),
        ],
      },
    ];
    const listingsByVendor = [
      {
        vendorId: "1",
        listings: [lst("Cheap", 10.5), lst("Pricey", 200)],
      },
    ];
    const res = aggregateCompetitorIntel(reviewsByVendor, listingsByVendor);
    // Pricey: 1 × 200 × 0.64 = 128 ; Cheap: 2 × 10.5 × 0.64 = 13.44
    expect(res.items[0].itemName).toBe("Pricey");
    expect(res.items[0].estRevenueGbp).toBe(128);
    expect(res.items[1].itemName).toBe("Cheap");
    expect(res.items[1].estRevenueGbp).toBe(13.44);
  });

  it("handles an empty sample without throwing", () => {
    const res = aggregateCompetitorIntel([], []);
    expect(res.items).toEqual([]);
    expect(res.reviewsSampled).toBe(0);
    expect(res.vendorsCount).toBe(0);
    expect(res.unmatchedPriceCount).toBe(0);
  });
});
