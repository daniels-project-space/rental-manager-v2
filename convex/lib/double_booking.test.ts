import { describe, it, expect } from "vitest";
import { effEnd, computeWorstOverlap, type DBRow } from "./double_booking";

describe("effEnd", () => {
  const today = "2026-05-19";

  it("returns end_date as-is for confirmed reservation with future end", () => {
    expect(
      effEnd(
        { end_date: "2026-05-25", order_step: "BOOKED_AFTER_VERIFIED", status: "confirmed" },
        today,
      ),
    ).toBe("2026-05-25");
  });

  it("extends end_date to today for RETURNED + confirmed (overdue gear-out)", () => {
    expect(
      effEnd(
        { end_date: "2026-05-17", order_step: "RETURNED", status: "confirmed" },
        today,
      ),
    ).toBe(today);
  });

  it("extends end_date to today for DELIVERED + confirmed (overdue gear-out, within grace)", () => {
    expect(
      effEnd(
        { end_date: "2026-05-15", order_step: "DELIVERED", status: "confirmed" },
        today,
      ),
    ).toBe(today);
  });

  it("does NOT extend for RETURNED when status is not confirmed (e.g. completed)", () => {
    expect(
      effEnd(
        { end_date: "2026-05-15", order_step: "RETURNED", status: "completed" },
        today,
      ),
    ).toBe("2026-05-15");
  });

  it("does NOT extend for confirmed when order_step is VERIFIED", () => {
    expect(
      effEnd(
        { end_date: "2026-05-15", order_step: "VERIFIED", status: "confirmed" },
        today,
      ),
    ).toBe("2026-05-15");
  });

  it("preserves future end_date when RETURNED + confirmed (e>today branch)", () => {
    expect(
      effEnd(
        { end_date: "2026-06-01", order_step: "RETURNED", status: "confirmed" },
        today,
      ),
    ).toBe("2026-06-01");
  });

  it("does NOT extend ancient RETURNED+confirmed (30 days past) — phantom suppression", () => {
    // today = 2026-05-19, end_date = 2026-04-19 (30 days back) → far outside grace
    expect(
      effEnd(
        { end_date: "2026-04-19", order_step: "RETURNED", status: "confirmed" },
        today,
      ),
    ).toBe("2026-04-19");
  });

  it("extends RETURNED+confirmed exactly at 7-day grace boundary", () => {
    // today = 2026-05-19, end_date = 2026-05-12 (exactly 7 days back) → still extends
    expect(
      effEnd(
        { end_date: "2026-05-12", order_step: "RETURNED", status: "confirmed" },
        today,
      ),
    ).toBe(today);
  });

  it("does NOT extend RETURNED+confirmed past 7-day grace (8 days past)", () => {
    // today = 2026-05-19, end_date = 2026-05-11 (8 days back) → outside grace
    expect(
      effEnd(
        { end_date: "2026-05-11", order_step: "RETURNED", status: "confirmed" },
        today,
      ),
    ).toBe("2026-05-11");
  });

  it("regression: 1-2 day overdue RETURNED+confirmed still extends to today", () => {
    expect(
      effEnd(
        { end_date: "2026-05-18", order_step: "RETURNED", status: "confirmed" },
        today,
      ),
    ).toBe(today);
    expect(
      effEnd(
        { end_date: "2026-05-17", order_step: "RETURNED", status: "confirmed" },
        today,
      ),
    ).toBe(today);
  });
});

describe("computeWorstOverlap — FX3 scenario", () => {
  const today = "2026-05-19";
  const horizonEnd = "2026-08-17"; // ~90 days

  it("treats overdue RETURNED+confirmed rental as still-out today (FX3 case)", () => {
    // FX3 qty=3. Olivia 2 + Makenzie 1 + James 1 + Gerome 1 = 5 concurrent.
    // Olivia's row is RETURNED+confirmed with end_date 2 days in past — Hygglo
    // bucket "current". Pre-fix: dropped from today's sweep. Post-fix: counted.
    const rows: DBRow[] = [
      {
        // Olivia — overdue but still has gear (2 units)
        start_date: "2026-05-10",
        end_date: "2026-05-17",
        order_step: "RETURNED",
        status: "confirmed",
        qty: 2,
      },
      {
        // Makenzie — overlaps today
        start_date: "2026-05-18",
        end_date: "2026-05-21",
        order_step: "BOOKED_AFTER_VERIFIED",
        status: "confirmed",
        qty: 1,
      },
      {
        // James — overlaps today
        start_date: "2026-05-19",
        end_date: "2026-05-22",
        order_step: "BOOKED_AFTER_VERIFIED",
        status: "confirmed",
        qty: 1,
      },
      {
        // Gerome — overlaps today
        start_date: "2026-05-19",
        end_date: "2026-05-20",
        order_step: "BOOKED_AFTER_VERIFIED",
        status: "confirmed",
        qty: 1,
      },
    ];

    const result = computeWorstOverlap(rows, today, horizonEnd);
    expect(result.worstCount).toBe(5);
    expect(result.worstDay).toBe(today);
    expect(result.overlapping).toHaveLength(4);
  });

  it("WITHOUT the fix (status=completed → no extension), Olivia drops out", () => {
    // Same scenario but Olivia is status=completed → effEnd returns past date,
    // Olivia drops from today's overlap and qtySum is 3 (= qty, no conflict).
    const rows: DBRow[] = [
      {
        start_date: "2026-05-10",
        end_date: "2026-05-17",
        order_step: "RETURNED",
        status: "completed", // <- not confirmed
        qty: 2,
      },
      { start_date: "2026-05-18", end_date: "2026-05-21", status: "confirmed", qty: 1 },
      { start_date: "2026-05-19", end_date: "2026-05-22", status: "confirmed", qty: 1 },
      { start_date: "2026-05-19", end_date: "2026-05-20", status: "confirmed", qty: 1 },
    ];
    const result = computeWorstOverlap(rows, today, horizonEnd);
    // Worst day = 2026-05-19 with the three confirmed rentals = 3.
    expect(result.worstCount).toBe(3);
  });

  it("returns 0 when no rows overlap", () => {
    const result = computeWorstOverlap([], today, horizonEnd);
    expect(result.worstCount).toBe(0);
    expect(result.worstDay).toBe("");
  });
});
