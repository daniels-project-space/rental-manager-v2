/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Canonical account-slug enumeration.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Every code path that fans the "all accounts" total out into per-account
 * buckets (dashboard's realised-month invariant, revenue.ts' per-renter
 * lifetime loop, future per-account telemetry) MUST import this list rather
 * than redeclaring `["dbcinema", "leo", "daniel", "vertus"]` inline.
 *
 * Adding a 5th account is a one-line change here that propagates to every
 * consumer, including the runtime invariant inside
 * `dashboard.getStatsDrawerData` which would otherwise silently undercount
 * the new slug and warn about drift forever.
 */

export const ACCOUNT_SLUGS = ["dbcinema", "leo", "diogo", "dbcinema_web", "daniel", "vertus"] as const;
export type AccountSlug = (typeof ACCOUNT_SLUGS)[number];
