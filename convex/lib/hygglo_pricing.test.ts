import { describe, it, expect } from "vitest";
import { tierRateForDays, tierTotalForDays, describeTiers, rentalQuote, inclusiveRentalDays } from "./hygglo_pricing";
import { summarise } from "./renter_order_quote";

describe("owner and Lab pricing duration", () => {
  it("includes both calendar dates, including across a DST change", () => {
    expect(inclusiveRentalDays("2026-10-02", "2026-10-04")).toBe(3);
    expect(inclusiveRentalDays("2026-03-28", "2026-03-30")).toBe(3);
    expect(inclusiveRentalDays("2026-10-02", "2026-10-02")).toBe(1);
  });
  it("does not manufacture a duration from missing, reversed or normalized invalid dates", () => {
    for (const [start, end] of [[undefined, undefined], ["2026-10-04", "2026-10-02"], ["2026-02-30", "2026-03-03"]]) expect(inclusiveRentalDays(start, end)).toBeNull();
  });
  it("uses the exact line's tiers and quantity without rounding the daily rate first", () => {
    const order = summarise([{ name: "Exact Blackmagic listing", qty: 2, daily_price_gbp: 60, price_tiers: [{ days: 3, pricePerDay: 43.3333333333 }] }], "2026-10-02", "2026-10-04");
    expect(order.days).toBe(3);expect(order.total_gbp).toBe(260);
  });
  it("does not present a partly priced basket as a complete total", () => {
    expect(summarise([{ name: "Priced", qty: 1, daily_price_gbp: 60 }, { name: "Unknown", qty: 1 }], "2026-10-02", "2026-10-04").total_gbp).toBeNull();
  });
});

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
    expect(describeTiers(TIERS)).toBe("1 day £80, 3+ days ~£66.67/day (£200 for 3 days), 7+ days ~£50/day (£350 for 7 days)");
  });
});


describe("shared quotes", () => {
  it("uses raw rates for totals rather than rounded daily displays", () => {
    const quote = rentalQuote(TIERS, 80, 3, 2);
    expect(quote?.daily_rate_gbp).toBe(66.67);
    expect(quote?.listed_total_gbp).toBe(400);
    expect(quote?.daily_rate_is_approximate).toBe(true);
    expect(rentalQuote(TIERS, 80, 4)?.listed_total_gbp).toBe(267);
  });
  it("does not use a 3-day band's rate for a 1-day rental", () => {
    expect(tierRateForDays([{ days: 3, pricePerDay: 36.6666666667 }], 1)).toBeNull();
    expect(rentalQuote([{ days: 3, pricePerDay: 36.6666666667 }], 40, 1)?.listed_total_gbp).toBe(40);
  });
  it("rejects invalid quantity/duration and unknown prices", () => {
    for (const quantity of [0, -1, 1.5, 21]) expect(rentalQuote(TIERS, 80, 3, quantity)).toBeNull();
    expect(rentalQuote(TIERS, 80, 367)).toBeNull();
    expect(rentalQuote([], null, 3)).toBeNull();
  });
});
