/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Weekly Metrics Compute — Phase 5a.
 *  Pure functions: no Convex db handles, no side effects.
 *
 *  Inputs are pre-filtered slices of reservations / items, plus an optional
 *  per-line filter (item_id / kind / null=global). Each function returns
 *  only the fields it owns; the backfill action stitches them together
 *  into a `weekly_metrics` row.
 *
 *  Phase 5b will compose its own functions ON THE SAME ROW. To avoid
 *  collisions, every public type in this file is namespaced under
 *  `WeeklyMetricsPhase5a*` and the result shapes contain ONLY the fields
 *  listed in the Phase 5a section of `weekly_metrics` in `convex/schema.ts`.
 *
 *  Daniel's CLAUDE.md notes:
 *   - Revenue is gross gbp; net-to-owner ≈ gross × 0.64 (~36% Hygglo fees).
 *   - Hygglo dates INCLUSIVE: duration_days = max(1, round(diff/86400000)+1).
 *   - Only `confirmed` / `completed` rentals are "real" — obsolete rows
 *     count as DENIED, not COMPLETED.
 * ──────────────────────────────────────────────────────────────────────────
 */

import type { Doc, Id } from "../_generated/dataModel";
import {
  attributeRevenue,
  type AttributionContext,
  type RentalForAttribution,
} from "./revenue_attribution";

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

/** Subset of a reservation document the compute layer needs. We keep this
 *  narrow so callers can construct test fixtures cheaply.  */
export type ReservationForMetrics = {
  _id: Id<"reservations">;
  account_slug?: string;
  status: string;
  is_obsolete?: boolean;
  start_date?: string;
  end_date?: string;
  duration_days?: number;
  gross_paid_gbp?: number;
  net_to_owner_gbp?: number;
  denial_actor?:
    | "owner_denied"
    | "renter_ghosted"
    | "renter_cancelled_explicit"
    | "system_or_other";
  reclassified_outcome?:
    | "owner_denied"
    | "renter_ghosted"
    | "renter_cancelled_explicit"
    | "system_or_other";
  hygglo_system_signal?:
    | "owner_denied"
    | "renter_cancelled"
    | "auto_cancelled"
    | "verification_failed"
    | "approved"
    | "none";
  obsolete_reason?:
    | "owner_denied"
    | "renter_cancelled"
    | "verification_failed"
    | "other";
  expanded_items?: ReadonlyArray<{
    item_id: Id<"items">;
    item_name_canonical: string;
    qty: number;
  }>;
  resolved_items?: ReadonlyArray<{
    item_id: Id<"items">;
    item_name_canonical: string;
    qty?: number;
    revenue_gbp?: number;
  }>;
  items?: ReadonlyArray<{ item_name: string; qty?: number }>;
};

/** Filter for slicing reservations/items to one granularity row.
 *  - granularity="global": fields are undefined; everything contributes.
 *  - granularity="kind":   `kind` is set; only lines where item.kind == kind
 *                          contribute, and per-item amounts are summed.
 *  - granularity="item":   `item_id` is set; only lines for that item count.
 */
export type MetricsFilter =
  | { granularity: "global" }
  | { granularity: "kind"; kind: string }
  | { granularity: "item"; item_id: Id<"items">; kind?: string };

/** Week boundary in ISO `YYYY-MM-DD` form. Both ends INCLUSIVE. */
export type WeekRange = { week_start: string; week_end: string };

// ──────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** ISO date string (`YYYY-MM-DD`) → ms epoch at UTC midnight. */
function isoToMs(d: string): number {
  return Date.parse(`${d}T00:00:00.000Z`);
}

/** Days between two inclusive ISO dates, never less than 1. */
export function inclusiveDurationDays(
  start_date: string,
  end_date: string,
): number {
  const diff = isoToMs(end_date) - isoToMs(start_date);
  return Math.max(1, Math.round(diff / 86400000) + 1);
}

/** Effective duration: prefer the stored `duration_days`, fall back to
 *  inclusive-day diff. Always ≥1. */
export function effectiveDurationDays(r: ReservationForMetrics): number {
  if (typeof r.duration_days === "number" && r.duration_days >= 1) {
    return Math.round(r.duration_days);
  }
  if (r.start_date && r.end_date) {
    return inclusiveDurationDays(r.start_date, r.end_date);
  }
  return 1;
}

/** Does the rental's [start_date, end_date] overlap [week_start, week_end]?
 *  All dates are INCLUSIVE on both ends, ISO YYYY-MM-DD. */
export function overlapsWeek(
  r: ReservationForMetrics,
  week: WeekRange,
): boolean {
  const rs = r.start_date;
  const re = r.end_date;
  if (!rs || !re) return false;
  return rs <= week.week_end && re >= week.week_start;
}

/** Inclusive-day overlap count: days the rental "occupies" inside the week.
 *  Returns 0 if no overlap. */
export function unitDaysWithinWeek(
  r: ReservationForMetrics,
  week: WeekRange,
): number {
  if (!r.start_date || !r.end_date) return 0;
  if (!overlapsWeek(r, week)) return 0;
  const startMs = Math.max(isoToMs(r.start_date), isoToMs(week.week_start));
  const endMs = Math.min(isoToMs(r.end_date), isoToMs(week.week_end));
  return Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
}

/** A rental is "completed" (counts toward realised revenue / unit-days)
 *  when it is NOT obsolete and has a real money figure. status enum
 *  includes "confirmed" | "completed" — both qualify. */
export function isCompleted(r: ReservationForMetrics): boolean {
  if (r.is_obsolete === true) return false;
  if (r.status === "cancelled" || r.status === "declined") return false;
  if (r.status === "pending_review") return false;
  // confirmed / completed both keep capacity occupied and revenue realised
  return r.status === "confirmed" || r.status === "completed";
}

/** Phase 3d denial outcome bucket. Falls through:
 *    denial_actor → reclassified_outcome → hygglo_system_signal → obsolete_reason
 *  Returns `null` if the row is not a denial at all. */
export function denialOutcome(
  r: ReservationForMetrics,
):
  | "owner_denied"
  | "renter_ghosted"
  | "renter_cancelled_explicit"
  | "auto_cancelled"
  | "system_or_other"
  | null {
  if (r.is_obsolete !== true) return null;
  if (r.denial_actor) return r.denial_actor;
  if (r.reclassified_outcome) return r.reclassified_outcome;
  if (r.hygglo_system_signal && r.hygglo_system_signal !== "approved" && r.hygglo_system_signal !== "none") {
    if (r.hygglo_system_signal === "auto_cancelled") return "auto_cancelled";
    if (r.hygglo_system_signal === "verification_failed") return "system_or_other";
    if (r.hygglo_system_signal === "owner_denied") return "owner_denied";
    if (r.hygglo_system_signal === "renter_cancelled") return "renter_cancelled_explicit";
  }
  if (r.obsolete_reason === "owner_denied") return "owner_denied";
  if (r.obsolete_reason === "renter_cancelled") return "renter_cancelled_explicit";
  if (r.obsolete_reason === "verification_failed") return "system_or_other";
  return "system_or_other";
}

/** Pick the best line array for filtering, mirroring revenue_attribution. */
function pickLines(r: ReservationForMetrics): Array<{
  item_id?: Id<"items">;
  item_name_canonical: string;
  qty: number;
}> {
  if (r.expanded_items && r.expanded_items.length > 0) {
    return r.expanded_items.map((x) => ({
      item_id: x.item_id,
      item_name_canonical: x.item_name_canonical,
      qty: x.qty,
    }));
  }
  if (r.resolved_items && r.resolved_items.length > 0) {
    return r.resolved_items.map((x) => ({
      item_id: x.item_id,
      item_name_canonical: x.item_name_canonical,
      qty: x.qty ?? 1,
    }));
  }
  if (r.items && r.items.length > 0) {
    return r.items.map((x) => ({
      item_id: undefined,
      item_name_canonical: (x.item_name ?? "").trim(),
      qty: x.qty ?? 1,
    }));
  }
  return [];
}

/** Does any line on this rental match the filter?
 *  - global: always true
 *  - kind:   any line's resolved item.kind == filter.kind
 *  - item:   any line's item_id == filter.item_id
 */
export function rentalMatchesFilter(
  r: ReservationForMetrics,
  filter: MetricsFilter,
  itemById: Map<Id<"items">, Doc<"items">>,
): boolean {
  if (filter.granularity === "global") return true;
  const lines = pickLines(r);
  for (const ln of lines) {
    if (filter.granularity === "item") {
      if (ln.item_id && ln.item_id === filter.item_id) return true;
    } else {
      // kind
      const it = ln.item_id ? itemById.get(ln.item_id) : undefined;
      if (it && it.kind === filter.kind) return true;
    }
  }
  return false;
}

/** Per-line value used when slicing a rental down to a (kind|item) row.
 *  For "item" granularity: returns the share attributable to that item.
 *  For "kind"  granularity: returns the sum of shares across all matching
 *  lines.
 *  For "global" granularity: returns the rental's full gross_gbp.
 *
 *  Uses the existing attributeRevenue engine so the math matches dashboard
 *  exactly. If no resolved items or no context, falls back to whole gross
 *  for global and 0 for item/kind. */
export function attributedShareFor(
  r: ReservationForMetrics,
  filter: MetricsFilter,
  attrCtx: AttributionContext | null,
): number {
  const gross = r.gross_paid_gbp ?? 0;
  if (filter.granularity === "global") return gross;
  if (gross <= 0) return 0;
  if (!attrCtx) return 0;
  const rental: RentalForAttribution = {
    _id: r._id,
    gross_gbp: gross,
    duration_days: r.duration_days,
    expanded_items: r.expanded_items as RentalForAttribution["expanded_items"],
    resolved_items: r.resolved_items as RentalForAttribution["resolved_items"],
    items: r.items as RentalForAttribution["items"],
  };
  const lines = attributeRevenue(rental, attrCtx);
  let total = 0;
  for (const ln of lines) {
    if (filter.granularity === "item") {
      if (ln.key.id && ln.key.id === filter.item_id) total += ln.share;
    } else {
      // kind: look up the item via the context and compare kind
      const it = ln.key.id
        ? attrCtx.itemById.get(ln.key.id)
        : attrCtx.itemByCanonical.get(ln.key.nameCanonical);
      if (it && it.kind === filter.kind) total += ln.share;
    }
  }
  return total;
}

// ──────────────────────────────────────────────────────────────────────────
// Public compute functions
// ──────────────────────────────────────────────────────────────────────────

export type RevenueMetrics = {
  revenue_gross_gbp: number;
  revenue_attributed_gbp: number;
  revenue_net_gbp: number;
};

/** Revenue for the week, scoped by filter.
 *
 *  - revenue_gross_gbp: sum of gross_paid_gbp on rentals that COMPLETED in
 *    the week and match the filter.
 *  - revenue_attributed_gbp: same set, but per-rental we run
 *    `attributeRevenue` and sum just the lines matching the filter
 *    (kind/item). For "global", attributed == gross.
 *  - revenue_net_gbp: gross × 0.64 (Hygglo fee ≈ 36%). Per Daniel's
 *    CLAUDE.md note. If the row has `net_to_owner_gbp` set, prefer it.
 */
export function computeRevenueMetrics(
  reservations: ReadonlyArray<ReservationForMetrics>,
  week: WeekRange,
  filter: MetricsFilter,
  attrCtx: AttributionContext | null,
): RevenueMetrics {
  let gross = 0;
  let attributed = 0;
  let net = 0;
  for (const r of reservations) {
    if (!isCompleted(r)) continue;
    if (!overlapsWeek(r, week)) continue;
    if (
      filter.granularity !== "global" &&
      attrCtx &&
      !rentalMatchesFilter(r, filter, attrCtx.itemById)
    ) {
      continue;
    }
    const g = r.gross_paid_gbp ?? 0;
    if (filter.granularity === "global") {
      gross += g;
      attributed += g;
      net += r.net_to_owner_gbp ?? g * 0.64;
    } else {
      const share = attributedShareFor(r, filter, attrCtx);
      if (share <= 0) continue;
      // pro-rate gross/net by the attributed share (so per-item slices
      // sum back to the global row within rounding)
      const shareRatio = g > 0 ? share / g : 0;
      gross += share;
      attributed += share;
      net += (r.net_to_owner_gbp ?? g * 0.64) * shareRatio;
    }
  }
  return {
    revenue_gross_gbp: round2(gross),
    revenue_attributed_gbp: round2(attributed),
    revenue_net_gbp: round2(net),
  };
}

export type VolumeMetrics = {
  rentals_completed: number;
  rentals_requested: number;
  rentals_owner_denied: number;
  rentals_renter_cancelled: number;
  rentals_renter_ghosted: number;
  rentals_auto_cancelled: number;
};

/** Volume metrics by outcome, scoped by filter.
 *  A rental counts toward `rentals_completed` if isCompleted && overlapsWeek.
 *  A rental counts toward a denial bucket if it is obsolete AND its
 *  `obsolete_at`/`start_date` falls within the week — we use start_date
 *  because that's the rental window the customer asked for.
 *
 *  `rentals_requested` = completed + all denial buckets (the universe of
 *  attempts touching this week).
 */
export function computeVolumeMetrics(
  reservations: ReadonlyArray<ReservationForMetrics>,
  week: WeekRange,
  filter: MetricsFilter,
  itemById: Map<Id<"items">, Doc<"items">>,
): VolumeMetrics {
  let completed = 0;
  let owner_denied = 0;
  let renter_cancelled = 0;
  let renter_ghosted = 0;
  let auto_cancelled = 0;
  let system_other = 0;
  for (const r of reservations) {
    if (!overlapsWeek(r, week)) continue;
    if (filter.granularity !== "global" && !rentalMatchesFilter(r, filter, itemById)) continue;
    if (isCompleted(r)) {
      completed += 1;
      continue;
    }
    if (r.is_obsolete !== true) continue;
    const outcome = denialOutcome(r);
    if (outcome === "owner_denied") owner_denied += 1;
    else if (outcome === "renter_cancelled_explicit") renter_cancelled += 1;
    else if (outcome === "renter_ghosted") renter_ghosted += 1;
    else if (outcome === "auto_cancelled") auto_cancelled += 1;
    else system_other += 1;
  }
  const requested =
    completed +
    owner_denied +
    renter_cancelled +
    renter_ghosted +
    auto_cancelled +
    system_other;
  return {
    rentals_completed: completed,
    rentals_requested: requested,
    rentals_owner_denied: owner_denied,
    rentals_renter_cancelled: renter_cancelled,
    rentals_renter_ghosted: renter_ghosted,
    rentals_auto_cancelled: auto_cancelled,
  };
}

export type CapacityMetrics = {
  unit_days_rented: number;
  unit_days_capacity: number;
  utilization_rate: number;
};

/** Capacity / utilization for the week.
 *
 *  - For "item": unit_days_rented = sum over completed rentals overlapping
 *    the week, of (days_in_week × line.qty) where the line matches item_id.
 *    unit_days_capacity = 7 × item.qty.
 *
 *  - For "kind":  unit_days_rented summed across all items of that kind.
 *    unit_days_capacity = 7 × sum(item.qty for items of that kind).
 *
 *  - For "global": unit_days_rented summed across all lines.
 *    unit_days_capacity = 7 × sum(all items.qty). This is a loose
 *    upper bound, useful for trend comparison rather than absolute %.
 */
export function computeCapacityMetrics(
  reservations: ReadonlyArray<ReservationForMetrics>,
  week: WeekRange,
  filter: MetricsFilter,
  items: ReadonlyArray<Doc<"items">>,
  itemById: Map<Id<"items">, Doc<"items">>,
): CapacityMetrics {
  let unit_days_rented = 0;
  for (const r of reservations) {
    if (!isCompleted(r)) continue;
    if (!overlapsWeek(r, week)) continue;
    const daysInWeek = unitDaysWithinWeek(r, week);
    if (daysInWeek <= 0) continue;
    const lines = pickLines(r);
    for (const ln of lines) {
      const it = ln.item_id ? itemById.get(ln.item_id) : undefined;
      if (filter.granularity === "item") {
        if (ln.item_id && ln.item_id === filter.item_id) {
          unit_days_rented += daysInWeek * (ln.qty ?? 1);
        }
      } else if (filter.granularity === "kind") {
        if (it && it.kind === filter.kind) {
          unit_days_rented += daysInWeek * (ln.qty ?? 1);
        }
      } else {
        // global
        unit_days_rented += daysInWeek * (ln.qty ?? 1);
      }
    }
  }
  let capacityQty = 0;
  if (filter.granularity === "item") {
    const it = itemById.get(filter.item_id);
    capacityQty = it?.qty ?? 1;
  } else if (filter.granularity === "kind") {
    for (const it of items) {
      if (it.kind === filter.kind) capacityQty += it.qty ?? 0;
    }
  } else {
    for (const it of items) capacityQty += it.qty ?? 0;
  }
  const unit_days_capacity = capacityQty * 7;
  const utilization_rate =
    unit_days_capacity > 0
      ? Math.min(1, unit_days_rented / unit_days_capacity)
      : 0;
  return {
    unit_days_rented,
    unit_days_capacity,
    utilization_rate: round2(utilization_rate * 1000) / 1000, // 3dp
  };
}

export type PricingMetrics = {
  avg_daily_price_realized: number;
  avg_rental_duration_days: number;
};

/** Pricing metrics for the week.
 *  - avg_daily_price_realized = sum(gross_attributable) / sum(unit_days_rented)
 *  - avg_rental_duration_days = avg(duration_days) across completed rentals
 *    matching the filter that overlap the week.
 */
export function computePricingMetrics(
  reservations: ReadonlyArray<ReservationForMetrics>,
  week: WeekRange,
  filter: MetricsFilter,
  attrCtx: AttributionContext | null,
  itemById: Map<Id<"items">, Doc<"items">>,
): PricingMetrics {
  let revenue = 0;
  let unit_days = 0;
  let duration_sum = 0;
  let duration_count = 0;
  for (const r of reservations) {
    if (!isCompleted(r)) continue;
    if (!overlapsWeek(r, week)) continue;
    if (filter.granularity !== "global" && !rentalMatchesFilter(r, filter, itemById)) {
      continue;
    }
    duration_sum += effectiveDurationDays(r);
    duration_count += 1;
    const daysInWeek = unitDaysWithinWeek(r, week);
    if (filter.granularity === "global") {
      revenue += r.gross_paid_gbp ?? 0;
      // global unit_days: count all lines' qty * days
      const lines = pickLines(r);
      let qtyTotal = 0;
      for (const ln of lines) qtyTotal += ln.qty ?? 1;
      unit_days += daysInWeek * Math.max(1, qtyTotal);
    } else {
      const share = attributedShareFor(r, filter, attrCtx);
      revenue += share;
      const lines = pickLines(r);
      for (const ln of lines) {
        if (filter.granularity === "item") {
          if (ln.item_id && ln.item_id === filter.item_id) {
            unit_days += daysInWeek * (ln.qty ?? 1);
          }
        } else {
          // kind
          const it = ln.item_id ? itemById.get(ln.item_id) : undefined;
          if (it && it.kind === filter.kind) {
            unit_days += daysInWeek * (ln.qty ?? 1);
          }
        }
      }
    }
  }
  return {
    avg_daily_price_realized:
      unit_days > 0 ? round2(revenue / unit_days) : 0,
    avg_rental_duration_days:
      duration_count > 0 ? round2(duration_sum / duration_count) : 0,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Helper: ISO Monday of a given date
// ──────────────────────────────────────────────────────────────────────────

/** Returns the Monday of the ISO week containing the given date (UTC).
 *  Returns `YYYY-MM-DD`. */
export function isoMondayOf(d: Date): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // getUTCDay: Sun=0..Sat=6 → shift so Mon=0..Sun=6
  const day = (x.getUTCDay() + 6) % 7;
  x.setUTCDate(x.getUTCDate() - day);
  return x.toISOString().slice(0, 10);
}

/** Sunday of the ISO week starting on the given Monday. */
export function isoSundayFromMonday(monday: string): string {
  const ms = Date.parse(`${monday}T00:00:00.000Z`) + 6 * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Returns the next Monday's ISO date string from a Monday input. */
export function nextMonday(monday: string): string {
  const ms = Date.parse(`${monday}T00:00:00.000Z`) + 7 * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}
