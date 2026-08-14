import { describe, expect, it } from "vitest";
import {
  buildOneDayPriceAdjustmentPreview,
  type HyggloListing,
} from "./listings";

describe("buildOneDayPriceAdjustmentPreview", () => {
  it("freezes a rounded target for each valid one-day tier", () => {
    const listings: HyggloListing[] = [
      { id: 4, name: "Camera B", prices: [{ days: 1, pricePerDay: 99.99, price: 99.99 }] },
      { id: 2, name: "Camera A", prices: [{ days: 1, pricePerDay: 100, price: 100 }, { days: 3, pricePerDay: 80, price: 240 }] },
    ];

    const preview = buildOneDayPriceAdjustmentPreview("diogo", listings, 10);

    expect(preview).toMatchObject({
      account: "diogo",
      percent: 10,
      currency: "GBP",
      readyCount: 2,
      skippedCount: 0,
      conflictCount: 0,
    });
    expect(preview.rows).toEqual([
      expect.objectContaining({ listingId: 2, currentPricePerDay: 100, targetPricePerDay: 110, status: "ready" }),
      expect.objectContaining({ listingId: 4, currentPricePerDay: 99.99, targetPricePerDay: 109.99, status: "ready" }),
    ]);
  });

  it("keeps ambiguous or unusable tiers out of a future write plan", () => {
    const preview = buildOneDayPriceAdjustmentPreview("diogo", [
      { id: 1, name: "No tier", prices: [{ days: 3, pricePerDay: 80, price: 240 }] },
      { id: 2, name: "Duplicate tier", prices: [{ days: 1, pricePerDay: 100, price: 100 }, { days: 1, pricePerDay: 90, price: 90 }] },
      { id: 3, name: "Bad tier", prices: [{ days: 1, pricePerDay: 0, price: 0 }] },
    ], 10);

    expect(preview.readyCount).toBe(0);
    expect(preview.skippedCount).toBe(2);
    expect(preview.conflictCount).toBe(1);
    expect(preview.rows.map((row) => row.reason)).toEqual([
      "invalid_one_day_price",
      "duplicate_one_day_tier",
      "missing_one_day_tier",
    ]);
  });

  it("rejects unsafe or nonsensical percentages", () => {
    expect(() => buildOneDayPriceAdjustmentPreview("diogo", [], 0)).toThrow(/greater than 0/i);
    expect(() => buildOneDayPriceAdjustmentPreview("diogo", [], 30)).toThrow(/no more than 25/i);
  });
});
