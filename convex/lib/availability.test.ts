/**
 * Unit tests for the pure-function part of availability.ts.
 *
 * Convex DB-access tests (isItemUnitAvailable + diagnoseDenialAvailability)
 * require a Convex test harness. They are exercised in the Phase 4 smoke step
 * via `convex run --prod revenue:getMissedAndDeniedByCategory`. Here we lock
 * down the helper that is hot-path on the date math.
 */
import { describe, it, expect } from "vitest";
import { expandDateRange } from "./availability";

describe("expandDateRange", () => {
  it("returns single date for same-day rental", () => {
    expect(expandDateRange("2026-05-18", "2026-05-18")).toEqual(["2026-05-18"]);
  });

  it("returns inclusive range across days", () => {
    expect(expandDateRange("2026-05-18", "2026-05-20")).toEqual([
      "2026-05-18",
      "2026-05-19",
      "2026-05-20",
    ]);
  });

  it("returns empty when end before start", () => {
    expect(expandDateRange("2026-05-20", "2026-05-18")).toEqual([]);
  });

  it("returns empty for invalid date strings", () => {
    expect(expandDateRange("not-a-date", "2026-05-20")).toEqual([]);
    expect(expandDateRange("2026-05-18", "garbage")).toEqual([]);
  });

  it("caps at maxDays to bound cost", () => {
    const out = expandDateRange("2026-01-01", "2026-12-31", 5);
    expect(out.length).toBe(5);
    expect(out[0]).toBe("2026-01-01");
    expect(out[4]).toBe("2026-01-05");
  });

  it("crosses month boundaries", () => {
    expect(expandDateRange("2026-01-31", "2026-02-02")).toEqual([
      "2026-01-31",
      "2026-02-01",
      "2026-02-02",
    ]);
  });
});
