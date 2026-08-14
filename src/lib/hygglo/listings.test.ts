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
      // Targets are quantised to the nearest £0.50 (99.99 * 1.1 = 109.989 → 110).
      expect.objectContaining({ listingId: 2, currentPricePerDay: 100, targetPricePerDay: 110, status: "ready" }),
      expect.objectContaining({ listingId: 4, currentPricePerDay: 99.99, targetPricePerDay: 110, status: "ready" }),
    ]);
  });

  // These pin the preview to the SAME rules as the only code path that writes
  // a live listing: `convex/listing_price_admin.ts` (roundPrice → nearest
  // £0.50 floored at £1; MAX_ABS_PERCENT 50; negatives allowed). If this
  // block starts failing, the two have drifted and the preview is quoting
  // numbers the executor would not actually apply.
  it("quantises the target to the nearest £0.50, floored at £1", () => {
    const preview = buildOneDayPriceAdjustmentPreview("diogo", [
      // 12 * 1.05 = 12.60 → 12.50 (whole-pound rounding would have moved it 0 or £1)
      { id: 1, name: "A cheap", prices: [{ days: 1, pricePerDay: 12, price: 12 }] },
      // 12 * 1.07 = 12.84 → 13.00
      { id: 2, name: "B cheap", prices: [{ days: 1, pricePerDay: 12.19, price: 12.19 }] },
    ], 5);

    expect(preview.rows.map((r) => r.targetPricePerDay)).toEqual([12.5, 13]);
  });

  it("floors the target at £1 however deep the cut", () => {
    const preview = buildOneDayPriceAdjustmentPreview("diogo", [
      { id: 1, name: "Tiny", prices: [{ days: 1, pricePerDay: 1.5, price: 1.5 }] },
    ], -50);

    expect(preview.rows[0]).toMatchObject({ currentPricePerDay: 1.5, targetPricePerDay: 1, status: "ready" });
  });

  it("allows price cuts (negative percentages), like the write path", () => {
    const preview = buildOneDayPriceAdjustmentPreview("diogo", [
      { id: 1, name: "Camera", prices: [{ days: 1, pricePerDay: 100, price: 100 }] },
    ], -10);

    expect(preview.percent).toBe(-10);
    expect(preview.rows[0]).toMatchObject({ targetPricePerDay: 90, status: "ready" });
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
    expect(() => buildOneDayPriceAdjustmentPreview("diogo", [], 0)).toThrow(/non-zero/i);
    expect(() => buildOneDayPriceAdjustmentPreview("diogo", [], Number.NaN)).toThrow(/non-zero/i);
    // ±50 is the shared bound with convex/listing_price_admin.ts.
    expect(() => buildOneDayPriceAdjustmentPreview("diogo", [], 51)).toThrow(/±50/);
    expect(() => buildOneDayPriceAdjustmentPreview("diogo", [], -51)).toThrow(/±50/);
    expect(() => buildOneDayPriceAdjustmentPreview("diogo", [], 50)).not.toThrow();
  });
});
