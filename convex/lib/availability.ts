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
  booked_units: number; // sum of conflicting active reservations + repair holds
  is_fully_booked: boolean;
};

// ── Source-of-truth occupancy (matches the Active Rentals tile / overbooking /
//    calendar availability) — booked units come from CONFIRMED reservations'
//    expanded_items (fallback resolved_items), occupancy by effective dates,
//    NOT the calendar_holds ledger (1 row/day, can't represent >1 unit out). ──
type ResRow = Doc<"reservations">;
type ClaimRow = Doc<"insurance_claims">;

/**
 * SINGLE SOURCE OF TRUTH for when a damage case blocks stock.
 *
 * A case holds its repair_item_ids units ONLY while the gear is physically
 * away: quote_received (at the shop being assessed) and in_for_repair.
 * case_opened = damage merely logged at return — the gear is back on the
 * shelf and usually still rentable; payout_confirmation = repair done,
 * awaiting settlement money. Holding for EVERY non-terminal stage (the old
 * rule) silently shrank effective qty for weeks and produced phantom
 * "potentially overbooked" alerts (the FX3 case: two lingering cases held
 * 2 of 4 bodies, so 3 legitimate bookings read as an oversell of qty 2).
 */
const HOLDING_STAGES = new Set(["quote_received", "in_for_repair"]);

export function claimStage(c: { stage?: string; status?: string }): string {
  return c.stage ?? (c.status === "denied" ? "denied" : c.status === "settled" ? "added_to_revenue" : "case_opened");
}

export function claimHoldsStock(c: { stage?: string; status?: string }): boolean {
  return HOLDING_STAGES.has(claimStage(c));
}

export function bookedUnitsOnDate(rows: ResRow[], itemId: Id<"items">, date: string): number {
  let n = 0;
  for (const r of rows) {
    if (r.is_obsolete) continue;
    const effPick = r.pickup_date ?? r.start_date;
    const effRet = r.return_date ?? r.end_date;
    if (!effPick || !effRet || date < effPick || date > effRet) continue;
    const src = (r.expanded_items && r.expanded_items.length ? r.expanded_items : r.resolved_items) ?? [];
    for (const x of src) if (x.item_id === itemId) n += (x.qty ?? 1);
  }
  return n;
}

/** Units of an item held by cases whose stage means the gear is AWAY. */
export function repairHeldUnits(claims: ClaimRow[], itemId: Id<"items">): number {
  let n = 0;
  for (const c of claims) {
    if (!claimHoldsStock(c)) continue;
    for (const id of (c.repair_item_ids ?? [])) if (id === itemId) n += 1;
  }
  return n;
}

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

  // 2. Booked units — from CONFIRMED reservations' expanded_items (the Active
  //    Rentals / overbooking / calendar-availability source of truth).
  const confirmed = await ctx.db
    .query("reservations")
    .withIndex("by_status", (q) => q.eq("status", "confirmed"))
    .collect();
  const bookedUnits = bookedUnitsOnDate(confirmed, itemId, date);

  // Plus units out on repair (open cases) — same rule everywhere else.
  const claims = await ctx.db.query("insurance_claims").collect();
  const repairHeld = repairHeldUnits(claims, itemId);

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

  // Collect the occupancy sources ONCE (this runs per-item × per-date below).
  const confirmedRes = await ctx.db
    .query("reservations")
    .withIndex("by_status", (q) => q.eq("status", "confirmed"))
    .collect();
  const claimRows = await ctx.db.query("insurance_claims").collect();

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
    // Check each date — if ANY is fully booked, classify as fully_booked.
    // Same expanded_items occupancy + repair rule as the rest of the app.
    const blackouts = await ctx.db
      .query("owner_unavailability")
      .withIndex("by_item_date", (q) => q.eq("item_id", ref.item_id))
      .collect();
    const repairHeld = repairHeldUnits(claimRows, ref.item_id);
    const total = itemDoc.qty ?? 0;
    const blockedDates: string[] = [];
    for (const d of dates) {
      const blackout = blackouts.some((b) => b.start_date <= d && b.end_date >= d);
      const booked = bookedUnitsOnDate(confirmedRes, ref.item_id, d);
      if (blackout || total === 0 || booked + repairHeld >= total) blockedDates.push(d);
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
