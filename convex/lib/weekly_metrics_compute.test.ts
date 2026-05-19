/**
 * Unit tests for Phase 5a weekly_metrics_compute.
 * Synthetic reservations / items only. Pure functions; no Convex runtime.
 */

import { describe, expect, it } from "vitest";

import type { Doc, Id } from "../_generated/dataModel";
import type { AttributionContext } from "./revenue_attribution";
import {
  computeCapacityMetrics,
  computePricingMetrics,
  computeRevenueMetrics,
  computeVolumeMetrics,
  denialOutcome,
  effectiveDurationDays,
  inclusiveDurationDays,
  isCompleted,
  isoMondayOf,
  isoSundayFromMonday,
  overlapsWeek,
  unitDaysWithinWeek,
  type ReservationForMetrics,
  type WeekRange,
} from "./weekly_metrics_compute";

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

type ItemDoc = Doc<"items">;

function makeItem(args: {
  id: string;
  name: string;
  kind: string;
  qty?: number;
  daily_price?: number;
}): ItemDoc {
  return {
    _id: args.id as unknown as Id<"items">,
    _creationTime: 0,
    name_canonical: args.name,
    name_input: args.name,
    slug: args.name.toLowerCase().replace(/\s+/g, "-"),
    kind: args.kind,
    qty: args.qty ?? 1,
    unit_kind: "unit",
    is_marketing_only: false,
    status: "active",
    created_at: 0,
    updated_at: 0,
  } as unknown as ItemDoc;
}

function makeRental(args: {
  id: string;
  start: string;
  end: string;
  gross?: number;
  net?: number;
  status?: string;
  is_obsolete?: boolean;
  denial_actor?: ReservationForMetrics["denial_actor"];
  obsolete_reason?: ReservationForMetrics["obsolete_reason"];
  duration?: number;
  expanded?: Array<{ item_id: string; canonical: string; qty: number }>;
}): ReservationForMetrics {
  return {
    _id: args.id as unknown as Id<"reservations">,
    account_slug: "leo",
    status: args.status ?? "completed",
    is_obsolete: args.is_obsolete,
    start_date: args.start,
    end_date: args.end,
    duration_days: args.duration,
    gross_paid_gbp: args.gross,
    net_to_owner_gbp: args.net,
    denial_actor: args.denial_actor,
    obsolete_reason: args.obsolete_reason,
    expanded_items: args.expanded?.map((x) => ({
      item_id: x.item_id as unknown as Id<"items">,
      item_name_canonical: x.canonical,
      qty: x.qty,
    })),
  };
}

function makeCtx(items: ItemDoc[], prices: Record<string, number> = {}): AttributionContext {
  const itemById = new Map<Id<"items">, ItemDoc>();
  const itemByCanonical = new Map<string, ItemDoc>();
  for (const it of items) {
    itemById.set(it._id, it);
    itemByCanonical.set(it.name_canonical, it);
  }
  const priceByName = new Map<string, number>(Object.entries(prices));
  return { itemById, itemByCanonical, priceByName };
}

const WEEK: WeekRange = {
  week_start: "2026-04-13", // Monday
  week_end: "2026-04-19",   // Sunday
};

// ──────────────────────────────────────────────────────────────────────────
// Date / boundary helpers
// ──────────────────────────────────────────────────────────────────────────

describe("date helpers", () => {
  it("inclusiveDurationDays matches Hygglo INCLUSIVE rule", () => {
    expect(inclusiveDurationDays("2026-04-13", "2026-04-13")).toBe(1);
    expect(inclusiveDurationDays("2026-04-13", "2026-04-14")).toBe(2);
    expect(inclusiveDurationDays("2026-04-13", "2026-04-19")).toBe(7);
  });

  it("effectiveDurationDays prefers stored duration over diff", () => {
    expect(
      effectiveDurationDays({
        _id: "r1" as unknown as Id<"reservations">,
        status: "completed",
        start_date: "2026-04-13",
        end_date: "2026-04-19",
        duration_days: 3,
      }),
    ).toBe(3);
    expect(
      effectiveDurationDays({
        _id: "r1" as unknown as Id<"reservations">,
        status: "completed",
        start_date: "2026-04-13",
        end_date: "2026-04-15",
      }),
    ).toBe(3);
  });

  it("isoMondayOf and isoSundayFromMonday roundtrip", () => {
    expect(isoMondayOf(new Date("2026-04-17T15:00:00Z"))).toBe("2026-04-13");
    expect(isoSundayFromMonday("2026-04-13")).toBe("2026-04-19");
  });

  it("overlapsWeek covers boundaries", () => {
    const inside = makeRental({ id: "a", start: "2026-04-15", end: "2026-04-16", gross: 100 });
    const beforeWeek = makeRental({ id: "b", start: "2026-04-05", end: "2026-04-10", gross: 50 });
    const afterWeek = makeRental({ id: "c", start: "2026-04-20", end: "2026-04-22", gross: 60 });
    const spans = makeRental({ id: "d", start: "2026-04-10", end: "2026-04-25", gross: 200 });
    expect(overlapsWeek(inside, WEEK)).toBe(true);
    expect(overlapsWeek(beforeWeek, WEEK)).toBe(false);
    expect(overlapsWeek(afterWeek, WEEK)).toBe(false);
    expect(overlapsWeek(spans, WEEK)).toBe(true);
  });

  it("unitDaysWithinWeek clips to the week", () => {
    const inside = makeRental({ id: "a", start: "2026-04-15", end: "2026-04-16", gross: 100 });
    expect(unitDaysWithinWeek(inside, WEEK)).toBe(2);
    const spans = makeRental({ id: "d", start: "2026-04-10", end: "2026-04-25", gross: 200 });
    expect(unitDaysWithinWeek(spans, WEEK)).toBe(7);
    const outside = makeRental({ id: "x", start: "2026-04-01", end: "2026-04-05" });
    expect(unitDaysWithinWeek(outside, WEEK)).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Outcome classifier
// ──────────────────────────────────────────────────────────────────────────

describe("denialOutcome / isCompleted", () => {
  it("isCompleted returns true for confirmed and completed non-obsolete", () => {
    expect(isCompleted(makeRental({ id: "1", start: "2026-04-15", end: "2026-04-16", status: "completed" }))).toBe(true);
    expect(isCompleted(makeRental({ id: "2", start: "2026-04-15", end: "2026-04-16", status: "confirmed" }))).toBe(true);
    expect(isCompleted(makeRental({ id: "3", start: "2026-04-15", end: "2026-04-16", status: "completed", is_obsolete: true }))).toBe(false);
    expect(isCompleted(makeRental({ id: "4", start: "2026-04-15", end: "2026-04-16", status: "cancelled" }))).toBe(false);
  });

  it("denialOutcome reads denial_actor first, then falls back to obsolete_reason", () => {
    const owner = makeRental({
      id: "1",
      start: "2026-04-15",
      end: "2026-04-16",
      is_obsolete: true,
      denial_actor: "owner_denied",
    });
    expect(denialOutcome(owner)).toBe("owner_denied");
    const renter = makeRental({
      id: "2",
      start: "2026-04-15",
      end: "2026-04-16",
      is_obsolete: true,
      obsolete_reason: "renter_cancelled",
    });
    expect(denialOutcome(renter)).toBe("renter_cancelled_explicit");
    const ok = makeRental({ id: "3", start: "2026-04-15", end: "2026-04-16" });
    expect(denialOutcome(ok)).toBe(null);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Revenue
// ──────────────────────────────────────────────────────────────────────────

describe("computeRevenueMetrics", () => {
  it("global: sums gross, attributed=gross, net = net_to_owner OR gross×0.64", () => {
    const r1 = makeRental({ id: "1", start: "2026-04-13", end: "2026-04-15", gross: 100 });
    const r2 = makeRental({ id: "2", start: "2026-04-16", end: "2026-04-17", gross: 50, net: 40 });
    // obsolete = excluded
    const r3 = makeRental({ id: "3", start: "2026-04-14", end: "2026-04-15", gross: 999, is_obsolete: true });
    // outside week
    const r4 = makeRental({ id: "4", start: "2026-05-01", end: "2026-05-02", gross: 777 });
    const out = computeRevenueMetrics([r1, r2, r3, r4], WEEK, { granularity: "global" }, null);
    expect(out.revenue_gross_gbp).toBe(150);
    expect(out.revenue_attributed_gbp).toBe(150);
    // r1 net = 100*0.64 = 64; r2 net = 40 (explicit). total = 104.
    expect(out.revenue_net_gbp).toBe(104);
  });

  it("item: only sums attributed share for that item", () => {
    const camera = makeItem({ id: "i_cam", name: "FX3", kind: "camera_body" });
    const lens = makeItem({ id: "i_lens", name: "24-70 GM", kind: "lens" });
    const ctx = makeCtx([camera, lens]);
    const r1 = makeRental({
      id: "1",
      start: "2026-04-14",
      end: "2026-04-15",
      gross: 200,
      expanded: [
        { item_id: "i_cam", canonical: "FX3", qty: 1 },
        { item_id: "i_lens", canonical: "24-70 GM", qty: 1 },
      ],
    });
    const out = computeRevenueMetrics(
      [r1],
      WEEK,
      { granularity: "item", item_id: "i_cam" as unknown as Id<"items"> },
      ctx,
    );
    // Equal split fallback (no replacement_cost, no daily_price) → camera gets 100
    expect(out.revenue_attributed_gbp).toBe(100);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Volume
// ──────────────────────────────────────────────────────────────────────────

describe("computeVolumeMetrics", () => {
  it("buckets completed + denial outcomes correctly", () => {
    const completed = makeRental({ id: "1", start: "2026-04-13", end: "2026-04-15", gross: 50 });
    const ownerDenied = makeRental({
      id: "2",
      start: "2026-04-13",
      end: "2026-04-13",
      is_obsolete: true,
      denial_actor: "owner_denied",
    });
    const renterCancel = makeRental({
      id: "3",
      start: "2026-04-14",
      end: "2026-04-14",
      is_obsolete: true,
      denial_actor: "renter_cancelled_explicit",
    });
    const ghosted = makeRental({
      id: "4",
      start: "2026-04-15",
      end: "2026-04-15",
      is_obsolete: true,
      denial_actor: "renter_ghosted",
    });
    const outside = makeRental({
      id: "5",
      start: "2026-05-01",
      end: "2026-05-01",
      is_obsolete: true,
      denial_actor: "owner_denied",
    });
    const itemById = new Map<Id<"items">, ItemDoc>();
    const out = computeVolumeMetrics(
      [completed, ownerDenied, renterCancel, ghosted, outside],
      WEEK,
      { granularity: "global" },
      itemById,
    );
    expect(out.rentals_completed).toBe(1);
    expect(out.rentals_owner_denied).toBe(1);
    expect(out.rentals_renter_cancelled).toBe(1);
    expect(out.rentals_renter_ghosted).toBe(1);
    expect(out.rentals_requested).toBe(4);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Capacity
// ──────────────────────────────────────────────────────────────────────────

describe("computeCapacityMetrics", () => {
  it("global: rented vs capacity, utilization in [0,1]", () => {
    const camera = makeItem({ id: "i_cam", name: "FX3", kind: "camera_body", qty: 2 });
    const lens = makeItem({ id: "i_lens", name: "24-70 GM", kind: "lens", qty: 1 });
    const items = [camera, lens];
    const itemById = new Map<Id<"items">, ItemDoc>([
      [camera._id, camera],
      [lens._id, lens],
    ]);
    // One rental Mon..Wed (3 days × qty 1 of FX3 + qty 1 of lens) = 6 unit-days
    const r1 = makeRental({
      id: "1",
      start: "2026-04-13",
      end: "2026-04-15",
      gross: 200,
      expanded: [
        { item_id: "i_cam", canonical: "FX3", qty: 1 },
        { item_id: "i_lens", canonical: "24-70 GM", qty: 1 },
      ],
    });
    const out = computeCapacityMetrics([r1], WEEK, { granularity: "global" }, items, itemById);
    expect(out.unit_days_rented).toBe(6);
    expect(out.unit_days_capacity).toBe(7 * 3); // 2 + 1 = 3 inventory units × 7d = 21
    expect(out.utilization_rate).toBeGreaterThan(0);
    expect(out.utilization_rate).toBeLessThanOrEqual(1);
  });

  it("item: capacity = qty × 7, rented based on that item's qty per rental", () => {
    const camera = makeItem({ id: "i_cam", name: "FX3", kind: "camera_body", qty: 2 });
    const items = [camera];
    const itemById = new Map<Id<"items">, ItemDoc>([[camera._id, camera]]);
    // Rental spans full week with qty 2
    const r1 = makeRental({
      id: "1",
      start: "2026-04-13",
      end: "2026-04-19",
      gross: 500,
      expanded: [{ item_id: "i_cam", canonical: "FX3", qty: 2 }],
    });
    const out = computeCapacityMetrics(
      [r1],
      WEEK,
      { granularity: "item", item_id: "i_cam" as unknown as Id<"items"> },
      items,
      itemById,
    );
    expect(out.unit_days_rented).toBe(7 * 2);
    expect(out.unit_days_capacity).toBe(7 * 2);
    expect(out.utilization_rate).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Pricing
// ──────────────────────────────────────────────────────────────────────────

describe("computePricingMetrics", () => {
  it("global: avg_daily = total_gross / total_unit_days; avg_duration = avg(duration_days)", () => {
    const camera = makeItem({ id: "i_cam", name: "FX3", kind: "camera_body" });
    const itemById = new Map<Id<"items">, ItemDoc>([[camera._id, camera]]);
    const r1 = makeRental({
      id: "1",
      start: "2026-04-13",
      end: "2026-04-15", // 3 days
      gross: 300,
      duration: 3,
      expanded: [{ item_id: "i_cam", canonical: "FX3", qty: 1 }],
    });
    const r2 = makeRental({
      id: "2",
      start: "2026-04-16",
      end: "2026-04-16", // 1 day
      gross: 100,
      duration: 1,
      expanded: [{ item_id: "i_cam", canonical: "FX3", qty: 1 }],
    });
    const out = computePricingMetrics([r1, r2], WEEK, { granularity: "global" }, null, itemById);
    // 4 unit-days (3 + 1), 400 gross → 100/day
    expect(out.avg_daily_price_realized).toBe(100);
    expect(out.avg_rental_duration_days).toBe(2);
  });
});
