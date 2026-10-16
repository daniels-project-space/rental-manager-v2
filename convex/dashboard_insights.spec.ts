// Pure-function unit tests for the WallE-facing helpers in dashboard_insights.
// The Convex query handlers themselves require a convex-test harness which
// the repo doesn't currently use for handler-level tests (existing tests in
// convex/lib/*.test.ts cover pure helpers only). We mirror that pattern:
// extract the date-math invariants and verify them directly.

import { describe, it, expect, vi } from "vitest";
import type { QueryCtx } from "./_generated/server";
import { getDashboardInsightBundle } from "./dashboard_insights";
import { liveReservationsEndingSince } from "./lib/live_reservation_window";

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

describe("dashboard_insights — batched recent widget reads", () => {
  it("reads one bounded metrics window and preserves each card's account-scoped values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
    vi.stubEnv("OWNER_AUTH_REQUIRED", "false");
    const rows = [
      { account_slug: "dbcinema", granularity: "item", week_start: "2026-10-05", item_id: "item-a", item_name_canonical: "A", utilization_rate: 0.5, voluntary_denied_count: 1, voluntary_denied_estimated_gbp: 50, capacity_denied_count: 0, capacity_denied_estimated_gbp: 0 },
      { account_slug: "dbcinema", granularity: "item", week_start: "2026-10-12", item_id: "item-a", item_name_canonical: "A", utilization_rate: 0.75, voluntary_denied_count: 0, voluntary_denied_estimated_gbp: 0, capacity_denied_count: 2, capacity_denied_estimated_gbp: 100 },
      { account_slug: "dbcinema", granularity: "item", week_start: "2026-08-01", item_id: "item-b", item_name_canonical: "B", utilization_rate: 0.2, voluntary_denied_count: 2, voluntary_denied_estimated_gbp: 250, capacity_denied_count: 1, capacity_denied_estimated_gbp: 25 },
      { account_slug: "other", granularity: "item", week_start: "2026-10-12", item_id: "item-c", item_name_canonical: "C", utilization_rate: 0, voluntary_denied_count: 20, voluntary_denied_estimated_gbp: 2000, capacity_denied_count: 20, capacity_denied_estimated_gbp: 2000 },
      { account_slug: "dbcinema", granularity: "global", week_start: "2026-10-05", below_minimum_threshold_denied_count: 2, below_minimum_threshold_denied_estimated_gbp: 200, revenue_gross_gbp: 100, revenue_attributed_gbp: 90, revenue_net_gbp: 80 },
      { account_slug: "dbcinema", granularity: "global", week_start: "2026-10-12", below_minimum_threshold_denied_count: 3, below_minimum_threshold_denied_estimated_gbp: 300, revenue_gross_gbp: 200, revenue_attributed_gbp: 180, revenue_net_gbp: 160 },
      { account_slug: "dbcinema", granularity: "global", week_start: "2026-08-01", below_minimum_threshold_denied_count: 4, below_minimum_threshold_denied_estimated_gbp: 400, revenue_gross_gbp: 400, revenue_attributed_gbp: 360, revenue_net_gbp: 320 },
      { account_slug: "dbcinema", granularity: "global", week_start: "2026-07-01", below_minimum_threshold_denied_count: 100, below_minimum_threshold_denied_estimated_gbp: 10000, revenue_gross_gbp: 10000, revenue_attributed_gbp: 9000, revenue_net_gbp: 8000 },
    ];
    const indexReads: Array<{ index: string; gte?: [string, string] }> = [];
    const idReads: string[] = [];
    const db = {
      query: vi.fn((table: string) => table === "weekly_input_cache_state" ? {
        withIndex: (index: string, select: (q: any) => unknown) => {
          expect(index).toBe("by_key");
          const q = { eq: (field: string, value: string) => { expect([field, value]).toEqual(["key", "recent:v1"]); return q; } };
          select(q); return { unique: async () => null };
        },
      } : ({
        withIndex: (index: string, select: (q: any) => unknown) => {
          const bounds: { gte?: [string, string] } = {};
          const q = { gte: (field: string, value: string) => { bounds.gte = [field, value]; return q; } };
          select(q);
          indexReads.push({ index, ...bounds });
          return {
            collect: async () => rows.filter((row) => !bounds.gte || (row as any)[bounds.gte[0]] >= bounds.gte[1]),
          };
        },
      })),
      get: vi.fn(async (id: string) => {
        idReads.push(id);
        return id === "item-a" ? { _id: id, name_canonical: "A", replacement_cost_gbp: 5200 } : null;
      }),
    };

    try {
      const result = await (getDashboardInsightBundle as any)._handler(
        { db } as unknown as QueryCtx,
        { accountSlug: "dbcinema" },
      );

      expect(indexReads).toEqual([{ index: "by_week_account_granularity", gte: ["week_start", "2026-07-18"] }]);
      expect(db.query.mock.calls.map(([table]) => table)).toEqual(["weekly_input_cache_state", "weekly_metrics"]);
      expect(idReads).toEqual(["item-a"]);
      expect(result.voluntaryDenyHotList[0]).toMatchObject({ item_id: "item-b", count: 2, gbp: 250 });
      expect(result.capacityGapAlert[0]).toMatchObject({ item_id: "item-a", count: 2, gbp: 100 });
      expect(result.itemUtilizationRanking[0]).toMatchObject({ item_id: "item-a", utilization: 0.625, idle_cost_per_week: 37.5 });
      expect(result.belowMinimumCounter).toEqual({ count: 9, gbp: 900, days: 90 });
      expect(result.weeklyRevenueSparkline).toEqual([
        { week_start: "2026-10-05", revenue_gross_gbp: 100, revenue_attributed_gbp: 90, revenue_net_gbp: 80 },
        { week_start: "2026-10-12", revenue_gross_gbp: 200, revenue_attributed_gbp: 180, revenue_net_gbp: 160 },
      ]);
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });
});

describe("liveReservationsEndingSince — indexed source window", () => {
  it("uses status/end-date ranges and keeps the original start-date cutoff", async () => {
    const confirmed = [
      { id: "inside-confirmed", start_date: "2026-08-17" },
      { id: "too-old", start_date: "2026-08-16" },
      { id: "missing-start" },
    ];
    const completed = [{ id: "inside-completed", start_date: "2026-10-02" }];
    const reads: Array<{ table: string; index: string; status: string; endCutoff: string }> = [];
    const query = vi.fn((table: string) => ({
      withIndex: vi.fn((index: string, range: (q: any) => any) => {
        const bounds: { status?: string; endCutoff?: string } = {};
        const q = {
          eq: (field: string, value: string) => {
            if (field === "status") bounds.status = value;
            return q;
          },
          gte: (field: string, value: string) => {
            if (field === "end_date") bounds.endCutoff = value;
            return q;
          },
        };
        range(q);
        reads.push({
          table,
          index,
          status: bounds.status ?? "",
          endCutoff: bounds.endCutoff ?? "",
        });
        return { collect: async () => bounds.status === "confirmed" ? confirmed : completed };
      }),
    }));
    const ctx = { db: { query } } as unknown as QueryCtx;

    const rows = await liveReservationsEndingSince(ctx, "2026-08-17", "2026-10-02");

    expect(rows.map((row) => (row as unknown as { id: string }).id).sort()).toEqual([
      "inside-completed",
      "inside-confirmed",
    ]);
    expect(reads).toEqual([
      { table: "reservations", index: "by_status_end_date", status: "confirmed", endCutoff: "2026-10-02" },
      { table: "reservations", index: "by_status_end_date", status: "completed", endCutoff: "2026-10-02" },
    ]);
  });
});
