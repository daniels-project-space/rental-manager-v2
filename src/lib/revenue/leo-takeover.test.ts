import { describe, expect, it } from "vitest";
import { calculateLeoTakeoverPerformance } from "./leo-takeover";

describe("Leo takeover revenue performance", () => {
  it("uses only completed months from August 2026 onward and ignores future months", () => {
    expect(calculateLeoTakeoverPerformance([
      { month: "2026-05", revenue: 100 },
      { month: "2026-06", revenue: 200 },
      { month: "2026-07", revenue: 0 },
      { month: "2026-08", revenue: 400 },
      { month: "2026-09", revenue: 200 },
      { month: "2026-10", revenue: 9_999 },
    ], "2026-09")).toEqual({
      beforeAverage: 100,
      afterAverage: 400,
      beforeMonths: 3,
      afterMonths: 1,
      deltaPct: 300,
    });
  });

  it("keeps zero-revenue months in the denominator instead of inflating performance", () => {
    const result = calculateLeoTakeoverPerformance([
      { month: "2026-05", revenue: 0 },
      { month: "2026-06", revenue: 300 },
      { month: "2026-07", revenue: 300 },
      { month: "2026-08", revenue: 500 },
      { month: "2026-09", revenue: 0 },
    ], "2026-10");
    expect(result.beforeMonths).toBe(3);
    expect(result.beforeAverage).toBe(200);
    expect(result.afterMonths).toBe(2);
    expect(result.afterAverage).toBe(250);
    expect(result.deltaPct).toBe(25);
  });

  it("caps the comparison baseline at the preceding 24 calendar months", () => {
    const before = Array.from({ length: 25 }, (_, index) => ({
      month: new Date(Date.UTC(2024, 6 + index, 1)).toISOString().slice(0, 7),
      revenue: index === 0 ? 10_000 : 100,
    }));
    const result = calculateLeoTakeoverPerformance([
      ...before,
      { month: "2026-08", revenue: 200 },
    ], "2026-09");
    expect(result.beforeMonths).toBe(24);
    expect(result.beforeAverage).toBe(100);
    expect(result.afterAverage).toBe(200);
  });

  // ── Regression guard (2026-09-02) ────────────────────────────────────
  // The partial current month used to be averaged in at full weight, so the
  // headline cratered on the 1st of every month. On 2026-09-02 the real
  // dashboard read (Aug £3,484 + Sep £835) / 2 = £2,160/mo because September
  // was two days old. Both sides must ignore the current month.
  it("excludes the partial current month so a fresh month cannot drag the average down", () => {
    const rows = [
      { month: "2026-06", revenue: 4_758 },
      { month: "2026-07", revenue: 4_320 },
      { month: "2026-08", revenue: 3_484 },
      { month: "2026-09", revenue: 835 },
    ];
    const result = calculateLeoTakeoverPerformance(rows, "2026-09");
    expect(result.afterAverage).toBe(3_484);
    expect(result.afterMonths).toBe(1);
    // The value must not move as the partial month accrues revenue.
    const later = calculateLeoTakeoverPerformance(
      rows.map((r) => (r.month === "2026-09" ? { ...r, revenue: 2_900 } : r)),
      "2026-09",
    );
    expect(later.afterAverage).toBe(result.afterAverage);
  });

  it("matches the Avg/mo boundary rule: a month counts only once it is complete", () => {
    const rows = [
      { month: "2026-08", revenue: 3_484 },
      { month: "2026-09", revenue: 3_000 },
    ];
    expect(calculateLeoTakeoverPerformance(rows, "2026-09").afterMonths).toBe(1);
    // Once September completes (current month rolls to October) it joins.
    const rolled = calculateLeoTakeoverPerformance(rows, "2026-10");
    expect(rolled.afterMonths).toBe(2);
    expect(rolled.afterAverage).toBe(3_242);
  });
});
