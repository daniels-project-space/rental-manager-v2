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
