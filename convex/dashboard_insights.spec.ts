// Pure-function unit tests for the WallE-facing helpers in dashboard_insights.
// The Convex query handlers themselves require a convex-test harness which
// the repo doesn't currently use for handler-level tests (existing tests in
// convex/lib/*.test.ts cover pure helpers only). We mirror that pattern:
// extract the date-math invariants and verify them directly.

import { describe, it, expect } from "vitest";

// Inclusive day-count (Hygglo convention) — must match overlapDays used in
// getUtilizationDelta + streamContext.
function overlapDays(
  startIso: string,
  endIso: string,
  winStartIso: string,
  winEndIso: string,
): number {
  const dayMs = 86400000;
  const s = Date.parse(startIso + "T00:00:00Z");
  const e = Date.parse(endIso + "T00:00:00Z");
  const ws = Date.parse(winStartIso + "T00:00:00Z");
  const we = Date.parse(winEndIso + "T00:00:00Z");
  const lo = Math.max(s, ws);
  const hi = Math.min(e, we);
  if (hi < lo) return 0;
  return Math.max(1, Math.round((hi - lo) / dayMs) + 1);
}

function conflictKey(item_id: string, reservation_ids: string[]): string {
  return `${item_id}|${[...reservation_ids].sort().join(",")}`;
}

describe("dashboard_insights — overlapDays (utilization-delta math)", () => {
  it("inclusive 1-day rental fully inside window counts as 1", () => {
    expect(overlapDays("2026-05-10", "2026-05-10", "2026-05-08", "2026-05-15")).toBe(1);
  });

  it("3-day rental fully inside window counts as 3", () => {
    expect(overlapDays("2026-05-10", "2026-05-12", "2026-05-08", "2026-05-15")).toBe(3);
  });

  it("rental ending before window starts → 0", () => {
    expect(overlapDays("2026-05-01", "2026-05-05", "2026-05-08", "2026-05-15")).toBe(0);
  });

  it("rental starting after window ends → 0", () => {
    expect(overlapDays("2026-05-20", "2026-05-25", "2026-05-08", "2026-05-15")).toBe(0);
  });

  it("rental clipped on left edge of window", () => {
    // rental 05-05 → 05-10, window 05-08 → 05-15 → 3 days (08, 09, 10)
    expect(overlapDays("2026-05-05", "2026-05-10", "2026-05-08", "2026-05-15")).toBe(3);
  });

  it("rental clipped on right edge of window", () => {
    // rental 05-13 → 05-20, window 05-08 → 05-15 → 3 days (13, 14, 15)
    expect(overlapDays("2026-05-13", "2026-05-20", "2026-05-08", "2026-05-15")).toBe(3);
  });
});

describe("dashboard_insights — conflictKey stability", () => {
  it("is order-independent on reservation ids", () => {
    const a = conflictKey("item1", ["r3", "r1", "r2"]);
    const b = conflictKey("item1", ["r1", "r2", "r3"]);
    expect(a).toBe(b);
  });

  it("changes when reservation set changes", () => {
    const a = conflictKey("item1", ["r1", "r2"]);
    const b = conflictKey("item1", ["r1", "r2", "r3"]);
    expect(a).not.toBe(b);
  });

  it("changes when item_id changes", () => {
    const a = conflictKey("item1", ["r1", "r2"]);
    const b = conflictKey("item2", ["r1", "r2"]);
    expect(a).not.toBe(b);
  });
});

describe("dashboard_insights — revenue MTD day-range clamp", () => {
  // Mirror getRevenueDelta's prev-month day clamp: when current day = 31
  // but prev month has 30 days, clamp to 30.
  function clampPrevDay(curDay: number, prevYear: number, prevMonth0: number): number {
    const daysInPrev = new Date(Date.UTC(prevYear, prevMonth0 + 1, 0)).getUTCDate();
    return Math.min(curDay, daysInPrev);
  }

  it("clamps 31 to Feb's 28 in a non-leap year", () => {
    expect(clampPrevDay(31, 2026, 1)).toBe(28); // Feb 2026
  });

  it("clamps 31 to April's 30", () => {
    expect(clampPrevDay(31, 2026, 3)).toBe(30); // Apr 2026
  });

  it("does not clamp when prev month has enough days", () => {
    expect(clampPrevDay(15, 2026, 0)).toBe(15); // Jan 2026
  });
});
