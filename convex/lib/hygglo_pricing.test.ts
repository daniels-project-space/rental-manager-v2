import { describe, it, expect } from "vitest";
import { tierRateForDays, tierTotalForDays, describeTiers } from "./hygglo_pricing";

/** Real tier table from leo#1172440 ("BMPCC 6k PRO Cinema Kit + tripod"). */
const TIERS = [
  { days: 1, pricePerDay: 80, price: 80 },
  { days: 3, pricePerDay: 66.66666666666667, price: 200 },
  { days: 7, pricePerDay: 50, price: 350 },
  { days: 30 }, // Hygglo returns an empty row when the owner set no 30-day rate
];

describe("hygglo multi-day tiers", () => {
  it("reproduces Hygglo's own totals at each tier boundary", () => {
    expect(tierTotalForDays(TIERS, 1)).toBe(80);
    expect(tierTotalForDays(TIERS, 3)).toBe(200);
    expect(tierTotalForDays(TIERS, 7)).toBe(350);
  });

  it("uses the band the rental falls in, not the next tier up", () => {
    expect(tierRateForDays(TIERS, 2)).toBe(80);
    expect(tierRateForDays(TIERS, 4)).toBeCloseTo(66.667, 2);
    expect(tierRateForDays(TIERS, 6)).toBeCloseTo(66.667, 2);
    expect(tierRateForDays(TIERS, 10)).toBe(50);
  });

  it("does not overcharge a 4-day booking at the 1-day rate", () => {
    // The bug this exists to stop: 4 x £80 = £320, when Hygglo charges £267.
    expect(tierTotalForDays(TIERS, 4)).toBe(267);
    expect(tierTotalForDays(TIERS, 4)).toBeLessThan(80 * 4);
  });

  it("ignores tiers with no rate instead of treating them as free", () => {
    expect(tierRateForDays(TIERS, 45)).toBe(50);
  });

  it("returns null when there is no usable tier at all", () => {
    expect(tierRateForDays([], 3)).toBeNull();
    expect(tierRateForDays(undefined, 3)).toBeNull();
    expect(tierRateForDays([{ days: 30 }], 3)).toBeNull();
  });

  it("describes the tiers compactly for the prompt", () => {
    expect(describeTiers(TIERS)).toBe("1 day £80, 3+ days £67/day, 7+ days £50/day");
  });
});
