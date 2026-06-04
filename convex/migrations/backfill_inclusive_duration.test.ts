/**
 * Unit tests for the inclusive-duration backfill recompute logic.
 *
 * Targets `recomputeDuration` — the EXACT function the migration's chunk
 * mutation and dry-run query use to decide each row's corrected
 * `duration_days`. We assert the three behaviours the backfill spec requires:
 *   1. same-day rental → 1 (Hygglo counts both pickup + return day),
 *   2. the off-by-one undercount is corrected (old naive count → +1 inclusive),
 *   3. missing / invalid dates → null (caller SKIPS, never patches).
 *
 * The arithmetic itself lives in `hyggloInclusiveDays`
 * (src/hygglo-core/dates.ts) — the single source of truth shared with the live
 * poller. These tests verify the migration wraps it correctly (date-string
 * parsing + skip semantics), not the formula in isolation.
 */
import { describe, it, expect } from "vitest";
import { recomputeDuration } from "./backfill_inclusive_duration";
import { hyggloInclusiveDays } from "../../src/hygglo-core/dates";

describe("recomputeDuration — inclusive-day backfill", () => {
  it("same-day rental counts as 1 day", () => {
    expect(recomputeDuration("2026-05-13", "2026-05-13")).toBe(1);
  });

  it("Fri→Sun (2026-05-15 → 2026-05-17) is 3 inclusive days", () => {
    expect(recomputeDuration("2026-05-15", "2026-05-17")).toBe(3);
  });

  it("corrects the classic off-by-one: a 1-night booking is 2 inclusive days", () => {
    // Old naive formula: round((end-start)/DAY) = 1. Inclusive = 2.
    expect(recomputeDuration("2026-05-09", "2026-05-10")).toBe(2);
  });

  it("multi-day booking adds exactly one over the naive span", () => {
    // 2026-05-28 → 2026-06-01 = 4 nights → 5 inclusive days.
    expect(recomputeDuration("2026-05-28", "2026-06-01")).toBe(5);
  });

  it("returns null when start_date is missing (row is SKIPPED)", () => {
    expect(recomputeDuration(undefined, "2026-05-10")).toBeNull();
  });

  it("returns null when end_date is missing (row is SKIPPED)", () => {
    expect(recomputeDuration("2026-05-09", undefined)).toBeNull();
  });

  it("returns null when both dates are missing", () => {
    expect(recomputeDuration(undefined, undefined)).toBeNull();
  });

  it("returns null for an unparseable date string (row is SKIPPED)", () => {
    expect(recomputeDuration("not-a-date", "2026-05-10")).toBeNull();
    expect(recomputeDuration("2026-05-09", "garbage")).toBeNull();
  });

  it("never returns a value below 1 for valid dates (floor matches poller)", () => {
    // Reversed range still floors at 1 via hyggloInclusiveDays' max(1, ...).
    expect(recomputeDuration("2026-05-20", "2026-05-10")).toBeGreaterThanOrEqual(1);
  });

  it("agrees with hyggloInclusiveDays parsed at midnight UTC (poller parity)", () => {
    const cases: Array<[string, string]> = [
      ["2026-05-13", "2026-05-13"],
      ["2026-05-09", "2026-05-10"],
      ["2026-05-16", "2026-05-22"],
      ["2026-05-21", "2026-05-24"],
    ];
    for (const [s, e] of cases) {
      const expected = hyggloInclusiveDays(
        new Date(s).getTime(),
        new Date(e).getTime(),
      );
      expect(recomputeDuration(s, e)).toBe(expected);
    }
  });
});
