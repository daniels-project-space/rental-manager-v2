/**
 * Per-unit availability — Phase 4.
 *
 * Until now, the Missed-Revenue "gap" slice was computed as
 *   idle_days = days_in_window − Σ rentalDays_per_item_name
 * which is **underutilization** (idle inventory), not **turned-away demand**.
 *
 * Daniel's definition of gap (per his message):
 *   - Marketing-only gap: item listed but we don't own it
 *     (`items.is_marketing_only = true`)
 *   - Fully-booked gap: at the requested dates, ALL units of that item
 *     were already booked elsewhere
 *
 * Demand = sum of the two gap sub-causes (the "actually lost" total).
 *
 * This module exposes the primitives used by revenue.ts to detect those cases
 * on already-denied reservations. It checks reservations + calendar_holds +
 * owner_unavailability against items.qty.
 *
 * Pure-Convex helper — no actions, no external I/O. Cost-bounded: Phase 4
 * only invokes these on `owner_denied` reservation rows.
 */

import { QueryCtx } from "../_generated/server";
import { Id, Doc } from "../_generated/dataModel";

export type AvailabilityResult = {
  available: number; // units available at date
  total_units: number; // items.qty
  booked_units: number; // sum of conflicting active reservations + holds
  is_fully_booked: boolean;
};

/**
 * For a given itemId and date (YYYY-MM-DD), return availability vs total qty.
 * Counts:
 *   - calendar_holds rows where item_id matches and date matches (one row/day)
 *   - owner_unavailability rows covering the date
 *
 * Returns is_fully_booked = (booked_units >= total_units) OR
 *                          (any owner_unavailability covering the date).
 */
export async function isItemUnitAvailable(
  ctx: QueryCtx,
  itemId: Id<"items">,
  date: string,
): Promise<AvailabilityResult> {
  // 0. Item itself
  const item = await ctx.db.get(itemId);
  if (!item) {
    return {
      available: 0,
      total_units: 0,
      booked_units: 0,
      is_fully_booked: true,
    };
  }
  const totalUnits = (item as Doc<"items">).qty ?? 0;

  // 1. Owner unavailability — single row covering the date = blackout.
  //    Treat owner_unavailability as blocking ALL units (manual blackout).
  const blackouts = await ctx.db
    .query("owner_unavailability")
    .withIndex("by_item_date", (q) => q.eq("item_id", itemId))
    .collect();
  const hasBlackout = blackouts.some(
    (b) => b.start_date <= date && b.end_date >= date,
  );
  if (hasBlackout) {
    return {
      available: 0,
      total_units: totalUnits,
      booked_units: totalUnits,
      is_fully_booked: true,
    };
  }

  // 2. Calendar holds — one row per item per day. Each row = 1 unit busy.
  //    Holds with status `confirmed` or `completed` count as booked.
  const holds = await ctx.db
    .query("calendar_holds")
    .withIndex("by_item_date", (q) =>
      q.eq("item_id", itemId).eq("date", date),
    )
    .collect();
  const bookedUnits = holds.filter(
    (h) => (h.status ?? "confirmed") !== "cancelled",
  ).length;

  // Units out on repair (open, non-terminal insurance/damage cases) reduce
  // availability too — same effective-stock rule the overbooking detector,
  // out-of-stock tile and calendar availability bar use. Date-independent: an
  // item stays held until the case closes (terminal stage).
  const claims = await ctx.db.query("insurance_claims").collect();
  const REPAIR_TERMINAL = new Set(["added_to_revenue", "denied"]);
  const repairHeld = claims.filter((c) => {
    const cc = c as { stage?: string; status?: string; repair_item_ids?: Id<"items">[] };
    const st = cc.stage ?? (cc.status === "denied" ? "denied" : cc.status === "settled" ? "added_to_revenue" : "case_opened");
    if (REPAIR_TERMINAL.has(st)) return false;
    return (cc.repair_item_ids ?? []).some((id) => id === itemId);
  }).length;

  const available = Math.max(0, totalUnits - bookedUnits - repairHeld);
  return {
    available,
    total_units: totalUnits,
    booked_units: bookedUnits + repairHeld,
    is_fully_booked: totalUnits === 0 || available <= 0,
  };
}

/**
 * For a multi-item rental request that was DENIED, compute per-item
 * availability across the requested date range.
 *
 * Returns:
 *   - fully_booked_items: items whose ALL units were busy on ≥1 requested date
 *   - marketing_only_items: items where `is_marketing_only=true`
 *   - available_anyway: items that WERE available — i.e. Daniel had inventory
 *     and still turned the request away (voluntary deny)
 *
 * Uses resolved_items[]/expanded_items[] from the reservation. Falls back to
 * raw items[] when neither is populated. Items that can't be matched to the
 * inventory table are silently dropped (matches existing classifier behavior).
 */
export async function diagnoseDenialAvailability(
  ctx: QueryCtx,
  reservation: Doc<"reservations">,
): Promise<{
  fully_booked_items: Array<{
    item_id: Id<"items">;
    item_name: string;
    dates: string[];
  }>;
  marketing_only_items: Array<{ item_id: Id<"items">; item_name: string }>;
  available_anyway: Array<{ item_id: Id<"items">; item_name: string }>;
}> {
  const fully_booked_items: Array<{
    item_id: Id<"items">;
    item_name: string;
    dates: string[];
  }> = [];
  const marketing_only_items: Array<{
    item_id: Id<"items">;
    item_name: string;
  }> = [];
  const available_anyway: Array<{
    item_id: Id<"items">;
    item_name: string;
  }> = [];

  // Source of item refs — prefer expanded_items (bundle-decomposed) over
  // resolved_items (LLM-canonicalized). Skip if neither exists.
  const sourceItems: Array<{
    item_id: Id<"items">;
    item_name_canonical: string;
  }> = [];
  const seen = new Set<string>();
  for (const xi of reservation.expanded_items ?? []) {
    if (xi.item_id && !seen.has(xi.item_id)) {
      sourceItems.push({
        item_id: xi.item_id,
        item_name_canonical: xi.item_name_canonical,
      });
      seen.add(xi.item_id);
    }
  }
  if (sourceItems.length === 0) {
    for (const ri of reservation.resolved_items ?? []) {
      if (ri.item_id && !seen.has(ri.item_id)) {
        sourceItems.push({
          item_id: ri.item_id,
          item_name_canonical: ri.item_name_canonical,
        });
        seen.add(ri.item_id);
      }
    }
  }
  if (sourceItems.length === 0) return { fully_booked_items, marketing_only_items, available_anyway };

  // Date range — prefer start_date/end_date (ISO strings); cap at 30 days
  // to bound query cost. Reservations without dates are skipped.
  const start = reservation.start_date;
  const end = reservation.end_date ?? reservation.start_date;
  if (!start || !end) return { fully_booked_items, marketing_only_items, available_anyway };
  const dates = expandDateRange(start, end, 30);
  if (dates.length === 0) return { fully_booked_items, marketing_only_items, available_anyway };

  for (const ref of sourceItems) {
    const item = await ctx.db.get(ref.item_id);
    if (!item) continue;
    const itemDoc = item as Doc<"items">;
    if (itemDoc.is_marketing_only) {
      marketing_only_items.push({
        item_id: ref.item_id,
        item_name: itemDoc.name_canonical,
      });
      continue;
    }
    // Check each date — if ANY is fully booked, classify as fully_booked
    const blockedDates: string[] = [];
    for (const d of dates) {
      const av = await isItemUnitAvailable(ctx, ref.item_id, d);
      if (av.is_fully_booked) blockedDates.push(d);
    }
    if (blockedDates.length > 0) {
      fully_booked_items.push({
        item_id: ref.item_id,
        item_name: itemDoc.name_canonical,
        dates: blockedDates,
      });
    } else {
      available_anyway.push({
        item_id: ref.item_id,
        item_name: itemDoc.name_canonical,
      });
    }
  }

  return { fully_booked_items, marketing_only_items, available_anyway };
}

/**
 * Expand "YYYY-MM-DD" ... "YYYY-MM-DD" (inclusive) into an array of dates.
 * Caps at maxDays to bound cost.
 */
export function expandDateRange(
  start: string,
  end: string,
  maxDays = 30,
): string[] {
  const out: string[] = [];
  const s = new Date(start + "T00:00:00Z").getTime();
  const e = new Date(end + "T00:00:00Z").getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return out;
  const oneDay = 86400_000;
  for (let t = s; t <= e && out.length < maxDays; t += oneDay) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
