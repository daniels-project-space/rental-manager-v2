/**
 * hygglo-core/dates — shared Hygglo date helpers.
 *
 * Hygglo rental periods are INCLUSIVE of both the pickup and the return day:
 * a booking whose start and end fall on the SAME calendar day is a 1-day
 * rental, and a Fri→Sun booking is 3 days (Fri, Sat, Sun) — not 2. The
 * correct day count is therefore:
 *
 *     Math.max(1, Math.round((endMs - startMs) / 86400000) + 1)
 *
 * The naïve `round((end - start) / 86400000)` UNDERCOUNTS by one and collapses
 * same-day rentals to 0/undefined — a money/utilisation bug (durations feed
 * per-day attribution). This is the single source of truth for that formula.
 */

/** Milliseconds in one day. */
const DAY_MS = 86400000;

/**
 * Inclusive Hygglo rental length in whole days.
 *
 * @param startMs rental start as epoch milliseconds
 * @param endMs   rental end as epoch milliseconds
 * @returns whole-day count, INCLUSIVE of both endpoints; always >= 1. Invalid
 *          / NaN inputs (e.g. an unparseable date) collapse to the 1-day
 *          minimum rather than producing NaN/0.
 */
export function hyggloInclusiveDays(startMs: number, endMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 1;
  return Math.max(1, Math.round((endMs - startMs) / DAY_MS) + 1);
}
