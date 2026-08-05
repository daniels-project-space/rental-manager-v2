import { describe, expect, it } from "vitest";
import { calculateLeoTakeoverPerformance } from "./leo-takeover";

describe("Leo takeover revenue performance", () => {
  it("uses only August 2026 onward for Leo's average and ignores future months", () => {
    expect(calculateLeoTakeoverPerformance([
      { month: "2026-05", revenue: 100 },
      { month: "2026-06", revenue: 200 },
      { month: "2026-07", revenue: 0 },
      { month: "2026-08", revenue: 400 },
      { month: "2026-09", revenue: 200 },
      { month: "2026-10", revenue: 9_999 },
    ], "2026-09")).toEqual({
      beforeAverage: 100,
      afterAverage: 300,
      beforeMonths: 3,
      afterMonths: 2,
      deltaPct: 200,
      includesPartialCurrentMonth: true,
    });
  });

  it("keeps zero-revenue months in the denominator instead of inflating performance", () => {
    const result = calculateLeoTakeoverPerformance([
      { month: "2026-06", revenue: 300 },
      { month: "2026-07", revenue: 300 },
      { month: "2026-08", revenue: 500 },
      { month: "2026-09", revenue: 0 },
    ], "2026-09");
    expect(result.beforeAverage).toBe(300);
    expect(result.afterAverage).toBe(250);
    expect(result.deltaPct).toBe(-17);
  });

  it("caps the comparison baseline at the preceding 24 calendar months", () => {
    const before = Array.from({ length: 25 }, (_, index) => ({
      month: new Date(Date.UTC(2024, 6 + index, 1)).toISOString().slice(0, 7),
      revenue: index === 0 ? 10_000 : 100,
    }));
    const result = calculateLeoTakeoverPerformance([
      ...before,
      { month: "2026-08", revenue: 200 },
    ], "2026-08");
    expect(result.beforeMonths).toBe(24);
    expect(result.beforeAverage).toBe(100);
    expect(result.afterAverage).toBe(200);
  });
});
