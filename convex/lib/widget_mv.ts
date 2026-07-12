/**
 * 2026-07-12 cost audit — reader-side helpers for the generic `mv_widgets`
 * cache (see convex/mv/widgets.ts for the refreshers).
 *
 * Pattern: a public dashboard query first tries its precomputed row
 * (`readWidgetMv`); on hit it returns the cached payload having subscribed
 * ONLY to that one small doc. On miss/stale it falls through to its
 * original live compute (correctness never depends on the cron being up).
 *
 * Age gates are refresher-cadence + slack: fast rows rebuild hourly via
 * mv_refresh_fast, slow rows daily via mv_refresh_slow. Past the gate the
 * reader treats the row as missing so a dead cron degrades to live (more
 * expensive, never wrong).
 */
import type { QueryCtx } from "../_generated/server";

export const FAST_WIDGET_MAX_AGE_MS = 4 * 60 * 60 * 1000; // hourly refresher + slack
export const SLOW_WIDGET_MAX_AGE_MS = 30 * 60 * 60 * 1000; // daily refresher + slack

/** MV row key for an account-scoped widget: `<widget>:<slug|all>[:extra]`. */
export function widgetSlugKey(accountSlug: string | null | undefined): string {
  return accountSlug ?? "all";
}

/**
 * Fetch a widget MV payload if present and fresh enough; null otherwise.
 * Reading only this row keeps the subscribing tab's read-set tiny — the
 * query re-executes only when the refresher actually patches this doc.
 */
export async function readWidgetMv(
  ctx: QueryCtx,
  key: string,
  maxAgeMs: number,
): Promise<unknown | null> {
  const row = await ctx.db
    .query("mv_widgets")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  if (!row) return null;
  if (Date.now() - row.generatedAt > maxAgeMs) return null;
  return row.payload;
}
