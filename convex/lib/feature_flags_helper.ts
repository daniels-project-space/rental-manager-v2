// ─────────────────────────────────────────────────────────────────────────────
// Helper for reading feature flags from inside Convex query/mutation handlers.
//
// Convex functions cannot call other Convex functions directly, so we use a
// plain TS helper that accepts a QueryCtx (or MutationCtx, both have ctx.db).
// Default OFF when row missing — safe for first-time rollout.
// ─────────────────────────────────────────────────────────────────────────────

import type { QueryCtx } from "../_generated/server";

export async function isFlagEnabled(
  ctx: QueryCtx,
  name: string,
): Promise<boolean> {
  const row = await ctx.db
    .query("feature_flags")
    .withIndex("by_name", (q) => q.eq("name", name))
    .first();
  return row?.enabled ?? false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Listing Info Pool per-account flag (2026-05-24).
//
// Naming convention: `listing_info_pool:<account_slug>` (boolean).
// When OFF (default), every pool-aware consumer falls back to the legacy
// path verbatim. To flip ON for one account from CLI:
//
//   npx convex run feature_flags:setFlag '{"name":"listing_info_pool:dbcinema","enabled":true}'
//
// `useInfoPoolForAccount` returns true ONLY when the row exists AND is
// enabled. The empty-row case (never set) returns false. A global
// kill-switch `listing_info_pool:*` overrides every per-account flag —
// when set to false, the pool stays off everywhere even if individual
// account flags are true.
// ─────────────────────────────────────────────────────────────────────────────

export async function useInfoPoolForAccount(
  ctx: QueryCtx,
  accountSlug: string,
): Promise<boolean> {
  // Global kill-switch first; if explicitly disabled, no account can opt in.
  const kill = await ctx.db
    .query("feature_flags")
    .withIndex("by_name", (q) => q.eq("name", "listing_info_pool:*"))
    .first();
  if (kill && kill.enabled === false) return false;
  // Per-account flag.
  const row = await ctx.db
    .query("feature_flags")
    .withIndex("by_name", (q) => q.eq("name", `listing_info_pool:${accountSlug}`))
    .first();
  return row?.enabled ?? false;
}

/** Set-based variant: returns the subset of slugs with the pool enabled.
 *  Avoids N lookups when a query handles multiple accounts at once. */
export async function infoPoolEnabledAccounts(
  ctx: QueryCtx,
  candidates: string[],
): Promise<Set<string>> {
  const kill = await ctx.db
    .query("feature_flags")
    .withIndex("by_name", (q) => q.eq("name", "listing_info_pool:*"))
    .first();
  if (kill && kill.enabled === false) return new Set();
  const out = new Set<string>();
  for (const slug of candidates) {
    const row = await ctx.db
      .query("feature_flags")
      .withIndex("by_name", (q) => q.eq("name", `listing_info_pool:${slug}`))
      .first();
    if (row?.enabled) out.add(slug);
  }
  return out;
}
