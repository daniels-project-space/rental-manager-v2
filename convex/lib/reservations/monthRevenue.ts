/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Realised month revenue — SINGLE SOURCE OF TRUTH (BACKEND).
 * ──────────────────────────────────────────────────────────────────────────
 *
 * SINGLE SOURCE OF TRUTH for "realised confirmed revenue for month M".
 *
 * INVARIANT: For any month M and account A:
 *   dashboard.getStatsDrawerData.confirmed.month_revenue (minus claims_value_gbp)
 *     === sum over slugs s of realisedMonthRevenue(rows, M, s).netGbp
 *     === realisedMonthRevenue(rows, M, null).netGbp
 *
 * DO NOT inline the filter chain in another file. Both dashboard.ts and
 * revenue.ts MUST call this helper for the current-month bucket. Drift
 * between the Month Confirmed tile and the LifetimeRevenue chart's live
 * bar is a bug HERE and only here.
 *
 * Past divergences fixed by this helper:
 *  - 2026-05-24: isConfirmedWithDates rejected `completed` rows;
 *    dashboard accepted them → £800.80 missing from lifetime (commit cc38126)
 *  - 2026-05-24: lifetime's loose blacklist accepted poller-populated
 *    APPROVED/FUNDS_RESERVED rows; dashboard whitelist did not → drift in
 *    the opposite direction (commit 7939e57)
 *
 * If you find yourself wanting to "tweak the predicate for X", add the
 * tweak HERE so all consumers stay aligned. Do NOT branch the predicate.
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
