/**
 * Capacity-gap diagnosis (Phase 5b).
 *
 * Daniel's directive (paraphrased): "for gaps you must look at what COMPLETED
 * rentals we had, when they were and what items were out and compare against
 * denied ones and their time frame and the inventory availability".
 *
 * Difference vs. `lib/availability.ts:diagnoseDenialAvailability`:
 *  - availability.ts checks calendar_holds + owner_unavailability (operational
 *    state of the calendar).
 *  - capacity_gap.ts checks the *historical record of COMPLETED rentals* — i.e.
 *    the rentals that actually happened. This is the ground-truth signal of
 *    "we couldn't take you because someone else already had it".
 *
 * Output: per-item classification (marketing_only | capacity_gap | voluntary)
 * + per-rental aggregate cause, plus an estimated £ value (gross_paid or
 * pricing-catalog fallback).
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { expandDateRange } from "./availability";

export type ItemDiagnosis = {
  item_id?: Id<"items">;
  canonical_name: string;
  requested_dates: string[];
  units_committed: number; // max committed units across requested_dates
  units_total: number; // items.qty
  is_marketing_only: boolean;
  classification: "capacity_gap" | "voluntary" | "marketing_only";
};

/**
 * Phase 5c — "below minimum threshold" sub-cause of voluntary.
 *
 * Hygglo platform fees ≈ 36% → net = gross × 0.64. Daniel's mental floor for
 * "worth bothering" is £25 net, which back-solves to £25 / 0.64 ≈ £39.06
 * gross. Rounded to £39 for clean numbers.
 *
 * A denial classified `voluntary` whose estimated gross < BELOW_MIN_GROSS
 * gets reclassified to `below_minimum_threshold` — "not worth the hassle",
 * distinct from a willful turn-away of full-priced inventory.
 */
export const BELOW_MIN_GROSS_GBP = 39;

export type DenialCause =
  | "capacity"
  | "voluntary"
  | "marketing_only"
  | "below_minimum_threshold"
  | "mixed"
  | "unknown";

export type DenialGapDiagnosis = {
  reservation_id: Id<"reservations">;
  cause: DenialCause;
  estimated_loss_gbp: number;
  per_item_diagnosis: ItemDiagnosis[];
};

/**
 * Memoised cache of "completed rentals committing a unit of itemId on date".
 * Caller can build once per backfill batch and reuse across denial diagnoses.
 *
 * Key: `${itemId}|${date}` (date = YYYY-MM-DD)
 * Value: number of completed-rental units committed on that date.
 */
export type CommitmentMap = Map<string, number>;

const commitKey = (itemId: string, date: string) => `${itemId}|${date}`;

/**
 * Build a commitment map from a list of completed reservations.
 *
 * "Completed" = status in {confirmed, completed}, not obsolete. We trust the
 * dedup-by-logical-rental upstream; this function does NOT dedup further.
 *
 * Each reservation contributes `qty` per item per date covered by
 * [start_date, end_date] (inclusive, capped at 30 days).
 */
export function buildCommitmentMap(
  completedReservations: Array<Doc<"reservations">>,
): CommitmentMap {
  const map: CommitmentMap = new Map();
  for (const r of completedReservations) {
    if (!r.start_date || !r.end_date) continue;
    const dates = expandDateRange(r.start_date, r.end_date, 31);
    if (dates.length === 0) continue;

    // Prefer expanded_items (kit-decomposed) > resolved_items > raw items
    const lines: Array<{ item_id?: Id<"items">; qty: number }> = [];
    if (r.expanded_items && r.expanded_items.length > 0) {
      for (const x of r.expanded_items) {
        lines.push({ item_id: x.item_id, qty: x.qty ?? 1 });
      }
    } else if (r.resolved_items && r.resolved_items.length > 0) {
      for (const x of r.resolved_items) {
        if (x.item_id) lines.push({ item_id: x.item_id, qty: x.qty ?? 1 });
      }
    }
    if (lines.length === 0) continue;

    for (const ln of lines) {
      if (!ln.item_id) continue;
      const idStr = String(ln.item_id);
      for (const d of dates) {
        const k = commitKey(idStr, d);
        map.set(k, (map.get(k) ?? 0) + ln.qty);
      }
    }
  }
  return map;
}

/**
 * Source-of-truth item refs for a reservation (expanded → resolved fallback).
 */
function sourceItemRefs(
  r: Doc<"reservations">,
): Array<{ item_id: Id<"items">; canonical: string }> {
  const out: Array<{ item_id: Id<"items">; canonical: string }> = [];
  const seen = new Set<string>();
  for (const xi of r.expanded_items ?? []) {
    if (xi.item_id && !seen.has(String(xi.item_id))) {
      out.push({ item_id: xi.item_id, canonical: xi.item_name_canonical });
      seen.add(String(xi.item_id));
    }
  }
  if (out.length === 0) {
    for (const ri of r.resolved_items ?? []) {
      if (ri.item_id && !seen.has(String(ri.item_id))) {
        out.push({ item_id: ri.item_id, canonical: ri.item_name_canonical });
        seen.add(String(ri.item_id));
      }
    }
  }
  return out;
}

/**
 * Phase 7.11b — name-based fallback for reservations whose `expanded_items` /
 * `resolved_items` were never populated (53 of 130 owner_denied rentals in
 * /tmp/gap_diagnostic). Substring matches the raw `items[].item_name` against
 * the canonical item names so we at least get a capacity diagnosis instead of
 * dumping the rental in `unknown`.
 *
 * Case-insensitive, longest-canonical-first to avoid prefix collisions
 * (e.g. "Sony A7" matching before "Sony A7 III"). Only returns the first
 * canonical hit per raw line — kits aren't reconstructed here, but a single
 * recognizable item is enough to classify the reservation.
 */
async function nameFallbackRefs(
  ctx: QueryCtx,
  r: Doc<"reservations">,
): Promise<Array<{ item_id: Id<"items">; canonical: string }>> {
  const raws = (r.items ?? [])
    .map((i: any) => (typeof i?.item_name === "string" ? i.item_name : ""))
    .filter((s: string) => s.length > 0);
  if (raws.length === 0) return [];

  const allItems = await ctx.db.query("items").collect();
  const canonicals = allItems
    .map((it) => ({ item_id: it._id, canonical: it.name_canonical }))
    .sort((a, b) => b.canonical.length - a.canonical.length);

  const out: Array<{ item_id: Id<"items">; canonical: string }> = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    const hay = raw.toLowerCase();
    for (const c of canonicals) {
      const needle = c.canonical.toLowerCase();
      if (needle.length < 4) continue;
      if (hay.includes(needle)) {
        const k = String(c.item_id);
        if (!seen.has(k)) {
          out.push({ item_id: c.item_id, canonical: c.canonical });
          seen.add(k);
        }
        break; // first match per raw line
      }
    }
  }
  return out;
}

/**
 * Estimate the gross £ for a (possibly denied) rental. Used both for £-loss
 * accounting AND for the Phase 5c below-minimum-threshold reclassification.
 *
 * Fallback chain:
 *   1. gross_paid_gbp on the row (if Hygglo captured it pre-denial)
 *   2. gross_gbp on the row (if separately populated)
 *   3. duration_days × pricing_catalog.daily_price_min for the first item
 *   4. 0
 *
 * Exported so the backfill / future callers can reuse the same definition
 * Daniel agreed on (no duplicate fallback chains drifting apart).
 */
export function estimated_gross_gbp(
  r: Doc<"reservations">,
  priceByName: Map<string, number>,
): number {
  if (typeof r.gross_paid_gbp === "number" && r.gross_paid_gbp > 0) {
    return r.gross_paid_gbp;
  }
  // `gross_gbp` is not currently in the reservations schema, but Daniel's spec
  // names it as a fallback. Tolerate either typed field or a forward-compat
  // dynamic field (returned by future Hygglo poller revisions).
  const rAny = r as unknown as { gross_gbp?: number };
  if (typeof rAny.gross_gbp === "number" && rAny.gross_gbp > 0) {
    return rAny.gross_gbp;
  }
  const firstItem = (r.items ?? [])[0];
  const lookupName =
    (r.resolved_items ?? [])[0]?.item_name_canonical ?? firstItem?.item_name;
  if (!lookupName) return 0;
  const daily = priceByName.get(lookupName);
  if (!daily) return 0;
  const days = Math.max(1, r.duration_days ?? 2);
  return daily * days;
}

/**
 * Legacy alias used by `diagnoseDenialCapacity` for £-loss accounting. Same
 * chain as `estimated_gross_gbp` — kept as an internal name for readability.
 */
function estimateLossGbp(
  r: Doc<"reservations">,
  priceByName: Map<string, number>,
): number {
  return estimated_gross_gbp(r, priceByName);
}

/**
 * Diagnose a single denied reservation's capacity-gap cause.
 *
 * For each requested item × each date in the rental's range:
 *   - count units committed by COMPLETED rentals on that date
 *   - compare to items.qty
 *   - if units_committed >= qty on any date → "capacity_gap"
 *   - if items.is_marketing_only=true → "marketing_only"
 *   - else → "voluntary" (Daniel had capacity, chose to deny)
 *
 * Reservation-level cause:
 *   - all items marketing_only → "marketing_only"
 *   - any item capacity_gap (and not all marketing) → "capacity" (mixed-tolerant)
 *   - all items voluntary → "voluntary"
 *   - mixed (capacity + voluntary) → "mixed" — counts as capacity in aggregates.
 *
 * Caller must pre-fetch:
 *   - `commitMap` built from completed reservations covering the rental's date
 *     range (so we don't re-scan the table per call).
 *   - `priceByName` for £ estimation.
 */
/**
 * Phase 7.11b — partial-commitment threshold. Strict `committed >= total`
 * leaves many "near miss" rentals (one of two units out, asked for both)
 * classified as voluntary even though the SECOND unit was committed elsewhere
 * and Daniel literally couldn't fulfil the order. We now also treat the day
 * as capacity-exhausted if the *remaining* capacity (total - committed) is
 * less than the rental's requested qty (so a 2-unit ask vs 1 free unit ⇒
 * capacity_gap, not voluntary).
 */
export const PARTIAL_CAPACITY_RATIO = 1.0; // committed/total threshold (1.0 = fully booked)
export const HIGH_UTILISATION_RATIO = 0.5; // committed/total ≥ 50% AND requested > free ⇒ capacity

export async function diagnoseDenialCapacity(
  ctx: QueryCtx,
  reservation: Doc<"reservations">,
  commitMap: CommitmentMap,
  priceByName: Map<string, number>,
): Promise<DenialGapDiagnosis> {
  let refs = sourceItemRefs(reservation);
  const estimated_loss_gbp = estimateLossGbp(reservation, priceByName);

  // Phase 7.11b — Cycle 4: name-based fallback when items weren't resolved.
  if (refs.length === 0) {
    refs = await nameFallbackRefs(ctx, reservation);
  }

  if (refs.length === 0) {
    return {
      reservation_id: reservation._id,
      cause: "unknown",
      estimated_loss_gbp,
      per_item_diagnosis: [],
    };
  }

  const start = reservation.start_date;
  const end = reservation.end_date ?? reservation.start_date;
  if (!start || !end) {
    return {
      reservation_id: reservation._id,
      cause: "unknown",
      estimated_loss_gbp,
      per_item_diagnosis: [],
    };
  }
  const dates = expandDateRange(start, end, 31);
  if (dates.length === 0) {
    return {
      reservation_id: reservation._id,
      cause: "unknown",
      estimated_loss_gbp,
      per_item_diagnosis: [],
    };
  }

  const per_item_diagnosis: ItemDiagnosis[] = [];

  for (const ref of refs) {
    const item = (await ctx.db.get(ref.item_id)) as Doc<"items"> | null;
    if (!item) {
      // Unknown item — skip (rare; means item was deleted post-denial).
      continue;
    }
    const idStr = String(ref.item_id);
    const total = item.qty ?? 0;

    if (item.is_marketing_only) {
      per_item_diagnosis.push({
        item_id: ref.item_id,
        canonical_name: item.name_canonical,
        requested_dates: dates,
        units_committed: 0,
        units_total: total,
        is_marketing_only: true,
        classification: "marketing_only",
      });
      continue;
    }

    // Walk every requested date; track peak commitment.
    let peakCommitted = 0;
    let everFullyBooked = false;
    let everHighUtil = false;
    // Requested qty from the reservation's expanded/resolved/items line for THIS item.
    let requestedQty = 1;
    for (const xi of reservation.expanded_items ?? []) {
      if (String(xi.item_id) === idStr) {
        requestedQty = Math.max(requestedQty, xi.qty ?? 1);
      }
    }
    for (const ri of reservation.resolved_items ?? []) {
      if (ri.item_id && String(ri.item_id) === idStr) {
        requestedQty = Math.max(requestedQty, ri.qty ?? 1);
      }
    }
    for (const d of dates) {
      const committed = commitMap.get(commitKey(idStr, d)) ?? 0;
      if (committed > peakCommitted) peakCommitted = committed;
      if (total > 0 && committed >= total) everFullyBooked = true;
      // Phase 7.11b — partial: if remaining (total - committed) < requestedQty
      // on any date, AND utilisation is ≥ HIGH_UTILISATION_RATIO, count it.
      if (total > 0) {
        const remaining = total - committed;
        const util = committed / total;
        if (
          remaining < requestedQty &&
          util >= HIGH_UTILISATION_RATIO
        ) {
          everHighUtil = true;
        }
      }
    }

    per_item_diagnosis.push({
      item_id: ref.item_id,
      canonical_name: item.name_canonical,
      requested_dates: dates,
      units_committed: peakCommitted,
      units_total: total,
      is_marketing_only: false,
      classification:
        everFullyBooked || everHighUtil ? "capacity_gap" : "voluntary",
    });
  }

  // Aggregate reservation-level cause.
  // Phase 7.11b — Cycle 3: ANY marketing-only item taints the rental as
  // marketing_only (was: requires ALL items marketing_only). Rationale: kits
  // where one rare lens (qty=0, flagged is_marketing_only) is in the line
  // were rejected because of THAT item — the rest of the kit is irrelevant
  // for "why was this denied".
  let cause: DenialGapDiagnosis["cause"] = "unknown";
  if (per_item_diagnosis.length > 0) {
    const classes = per_item_diagnosis.map((d) => d.classification);
    const hasCapacity = classes.includes("capacity_gap");
    const hasVoluntary = classes.includes("voluntary");
    const hasMktOnly = classes.includes("marketing_only");
    if (hasMktOnly && !hasCapacity) {
      // Marketing-only dominates over voluntary; capacity wins if both.
      cause = "marketing_only";
    } else if (hasCapacity && hasVoluntary) cause = "mixed";
    else if (hasCapacity) cause = "capacity";
    else if (hasVoluntary) cause = "voluntary";
    else cause = "unknown";
  }

  // Phase 5c — sub-classify voluntary denials below the £25-net (≈ £39
  // gross) threshold as `below_minimum_threshold`. Daniel's mental model:
  // "denied because not worth the hassle" is distinct from a willful
  // turn-away of full-priced inventory. Only voluntary maps here — capacity
  // / marketing_only / mixed retain their meaning regardless of price.
  if (cause === "voluntary") {
    const gross = estimated_gross_gbp(reservation, priceByName);
    if (gross > 0 && gross < BELOW_MIN_GROSS_GBP) {
      cause = "below_minimum_threshold";
    }
  }

  return {
    reservation_id: reservation._id,
    cause,
    estimated_loss_gbp,
    per_item_diagnosis,
  };
}

/**
 * Predicate used by callers to enumerate the "completed" rentals that
 * commit inventory. Matches the live/confirmed/completed semantics, EXCLUDES
 * obsolete/cancelled/declined.
 */
export function isCompletedCommitting(r: Doc<"reservations">): boolean {
  if (r.is_obsolete) return false;
  const s = r.status;
  return s === "confirmed" || s === "completed";
}
