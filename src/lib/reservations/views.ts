/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Reservation views — derived slices over the reservations table (FRONTEND).
 *  Mirror: convex/lib/reservations/views.ts (keep in sync).
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Synchronous functions that take an already-fetched `reservations[]` array
 * and return derived slices. Every dashboard widget query and chat tool that
 * touches reservation state should compose from these.
 *
 * Why sync (not async-with-ctx)? Convex queries already `.collect()` the full
 * reservations table (1700 rows in memory). Re-fetching per-view would waste
 * I/O. Pass the array once, derive many slices.
 */

import {
  type ReservationRow,
  dedupByLogicalRental,
  effectiveDate,
  inAccount,
  inDateRange,
  isConfirmedWithDates,
  isEarned,
  isLive,
  isOngoing,
  isPendingVerification,
  isUpcoming,
  netOf,
} from "./predicates";

export type AccountScope = string | null | undefined;

/** Apply account scope if non-empty, else pass through. */
function scope<T extends ReservationRow>(rows: T[], slug: AccountScope): T[] {
  return slug ? rows.filter(inAccount(slug)) : rows;
}

// ── active-card views (ongoing / upcoming / pending) ─────────

export interface ActiveSplit<T> {
  ongoing: T[];
  upcoming: T[];
  pending: T[];
}

/**
 * Active card slices, deduped. Mirror of dashboard.getStatsDrawerData's
 * Active card logic, extracted here as canonical:
 *   ongoing  = confirmed AND start <= today
 *   upcoming = confirmed AND start  > today
 *   pending  = order_step === VERIFIED AND NOT obsolete
 */
export function activeSplit<T extends ReservationRow>(rows: T[], today: string): ActiveSplit<T> {
  const ongoing  = rows.filter((r) => isOngoing(r, today));
  const upcoming = rows.filter((r) => isUpcoming(r, today));
  const pending  = rows.filter(isPendingVerification);
  return {
    ongoing:  dedupByLogicalRental(ongoing),
    upcoming: dedupByLogicalRental(upcoming),
    pending:  dedupByLogicalRental(pending),
  };
}

// ── revenue views ────────────────────────────────────────────

/** Live + earned-by-date rows (revenue that has landed). Deduped. */
export function earnedRevenue<T extends ReservationRow>(rows: T[], today: string): T[] {
  return dedupByLogicalRental(rows.filter((r) => isEarned(r, today)));
}

/** Earned revenue within an inclusive ISO date range. Deduped. */
export function earnedInRange<T extends ReservationRow>(
  rows: T[],
  today: string,
  start: string,
  end: string,
): T[] {
  return dedupByLogicalRental(
    rows.filter((r) => isEarned(r, today) && inDateRange(r, start, end)),
  );
}

/** Sum net_to_owner_gbp across rows. */
export function sumNet(rows: ReservationRow[]): number {
  return rows.reduce((s, r) => s + netOf(r), 0);
}

// ── monthly views ────────────────────────────────────────────

/**
 * Future bookings whose start_date falls in [monthStart, monthEnd] —
 * used for month-revenue projection (avgDaily * remaining + future bookings).
 */
export function bookedFutureInMonth<T extends ReservationRow>(
  rows: T[],
  today: string,
  monthStart: string,
  monthEnd: string,
): T[] {
  return dedupByLogicalRental(
    rows.filter((r) =>
      isConfirmedWithDates(r) &&
      (r.start_date as string) > today &&
      (r.start_date as string) >= monthStart &&
      (r.start_date as string) <= monthEnd,
    ),
  );
}

// ── account-scoped wrappers ──────────────────────────────────

/** Pre-scope rows by account, then expose the same view set. */
export function forAccount<T extends ReservationRow>(rows: T[], slug: AccountScope) {
  const scoped = scope(rows, slug);
  return {
    rows: scoped,
    activeSplit: (today: string) => activeSplit(scoped, today),
    earnedRevenue: (today: string) => earnedRevenue(scoped, today),
    earnedInRange: (today: string, start: string, end: string) =>
      earnedInRange(scoped, today, start, end),
    bookedFutureInMonth: (today: string, mStart: string, mEnd: string) =>
      bookedFutureInMonth(scoped, today, mStart, mEnd),
  };
}

// Re-export predicates for callers that want a single import.
export {
  dedupByLogicalRental,
  effectiveDate,
  isConfirmedWithDates,
  isEarned,
  isLive,
  isOngoing,
  isPendingVerification,
  isUpcoming,
  netOf,
} from "./predicates";
