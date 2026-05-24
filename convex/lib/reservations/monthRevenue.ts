/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Realised month revenue — SINGLE SOURCE OF TRUTH (BACKEND).
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The canonical "realised confirmed revenue for month M, account A (or all)".
 * Both `dashboard.getStatsDrawerData.confirmed.month_revenue` and
 * `revenue.getLifetimeByMonth` (current-month per-renter buckets) MUST derive
 * their numbers from this helper. Any divergence between the Month Confirmed
 * tile and the lifetime chart's live-month bar is a bug here.
 *
 * Filter chain (mirrors the Month Confirmed tile, which is the source of
 * truth per Daniel):
 *   1. !is_obsolete
 *   2. account_slug === slug      (when slug is provided)
 *   3. effectiveDate(r) is in month (pickup_date ?? start_date)
 *   4. status ∈ {"confirmed","completed"}  AND start_date+end_date present
 *      ─ Note: this is intentionally LOOSER than `isConfirmedWithDates`
 *        (which rejects "completed"). A finished rental still counts toward
 *        "Month Confirmed" revenue (v1 parity). Returned-and-completed rows
 *        in the live month account for ~£800 that strict-confirmed dropped.
 *   5. dedupByLogicalRental — collapse duplicate poll rows (Hygglo order id
 *      collisions, v1+Hygglo overlap). Keeps highest net_to_owner_gbp.
 *
 * Historical-month buckets in `getLifetimeByMonth` keep their legacy loose
 * predicate (status-blacklist) — v1-migrated rows lack confirmed-status
 * semantics and a strict filter would zero them out incorrectly. This helper
 * is for the LIVE month only.
 */

import {
  type ReservationRow,
  dedupByLogicalRental,
  effectiveDate,
  netOf,
} from "./predicates";

export type AccountScope = string | null | undefined;

/** True if row counts toward the Month Confirmed revenue tile. */
export function isRealisedMonthRow(r: ReservationRow): boolean {
  if (r.is_obsolete) return false;
  if (r.status !== "confirmed" && r.status !== "completed") return false;
  if (!r.start_date || !r.end_date) return false;
  return true;
}

export interface RealisedMonthRevenue<T extends ReservationRow> {
  rentals: T[];
  netGbp: number;
}

/**
 * Canonical computation. Returns the deduped rentals + summed
 * net_to_owner_gbp (rounded to 2dp) for the given YYYY-MM month, optionally
 * scoped to one account_slug.
 */
export function realisedMonthRevenue<T extends ReservationRow>(
  allReservations: T[],
  month: string,             // "YYYY-MM"
  accountSlug?: AccountScope,
): RealisedMonthRevenue<T> {
  const filtered = allReservations.filter((r) => {
    if (accountSlug && r.account_slug !== accountSlug) return false;
    const d = effectiveDate(r);
    if (d === undefined) return false;
    if (d.slice(0, 7) !== month) return false;
    return isRealisedMonthRow(r);
  });
  const deduped = dedupByLogicalRental(filtered);
  const netGbp = deduped.reduce((s, r) => s + netOf(r), 0);
  return { rentals: deduped, netGbp: Math.round(netGbp * 100) / 100 };
}
