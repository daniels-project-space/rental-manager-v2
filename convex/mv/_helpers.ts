/**
 * Shared helpers for MV refreshers.
 *
 * - upsertSingleton: writes one row per `account` slug (insert or patch).
 * - getAccountSlugs: returns the list of accounts to refresh.
 */
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { TableNames } from "../_generated/dataModel";
import { ACCOUNTS, ACCOUNT_ALL } from "./constants";

export type MvTableName =
  | "daily_briefing"
  | "top_earners_30d"
  | "purchase_signals"
  | "churn_risk_renters"
  | "utilization_today"
  | "upcoming_returns";

/**
 * Account slugs to compute MV rows for. Includes `"all"` aggregate.
 * Override at refresh time when only one account needs recomputing.
 */
export function getAccountSlugs(): readonly string[] {
  return [ACCOUNT_ALL, ...ACCOUNTS];
}

/**
 * Upsert a singleton MV row keyed by `account`.
 * Internal mutation wrapper — used by `refresh` actions via `ctx.runMutation`.
 */
export async function upsertSingleton<T extends Record<string, unknown>>(
  ctx: MutationCtx,
  table: MvTableName,
  account: string,
  doc: T,
): Promise<{ inserted: boolean }> {
  // Use generic query — `withIndex("by_account")` exists on all MV tables.
  const existing = await ctx.db
    .query(table as TableNames)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .withIndex("by_account" as any, (q) => q.eq("account", account))
    .first();

  if (existing) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctx.db.patch(existing._id as any, doc as any);
    return { inserted: false };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await ctx.db.insert(table as TableNames, { account, ...doc } as any);
  return { inserted: true };
}

/**
 * Compute "relative age" string for a generatedAt timestamp.
 * "live" if < 1 min, "N min ago" otherwise.
 */
export function relativeAge(generatedAtMs: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - generatedAtMs);
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 1) return "live";
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} h ago`;
  return `${Math.round(diffHr / 24)} d ago`;
}

/**
 * Filter reservations to an account slug or return all if `"all"`.
 */
export function filterByAccount<T extends { account_slug?: string }>(
  rows: T[],
  account: string,
): T[] {
  if (account === ACCOUNT_ALL) return rows;
  return rows.filter((r) => r.account_slug === account);
}

/** ISO date YYYY-MM-DD for "today" in UTC. */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** ISO date YYYY-MM-DD for `days` ago. */
export function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// Re-export for callers
export { ACCOUNT_ALL };
// Quiet unused-import lint for QueryCtx (re-export for symmetry with MutationCtx)
export type { QueryCtx };
