// ─────────────────────────────────────────────────────────────────────────────
// Runtime feature flags — Phase 2 attribution cutover.
//
// Daniel flips boolean flags from CLI (`convex run feature_flags:setFlag`) to
// switch code paths instantly (≈1s rollback). Default OFF when row missing.
//
// For in-Convex reads from query handlers, use the helper at
// `convex/lib/feature_flags_helper.ts` (cannot call a Convex function from
// inside another function).
// ─────────────────────────────────────────────────────────────────────────────

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const setFlag = mutation({
  args: { name: v.string(), enabled: v.boolean() },
  handler: async (ctx, { name, enabled }) => {
    const existing = await ctx.db
      .query("feature_flags")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        enabled,
        updated_at: now,
        updated_by: "phase-2",
      });
      return { action: "updated" as const, name, enabled };
    }
    await ctx.db.insert("feature_flags", {
      name,
      enabled,
      updated_at: now,
      updated_by: "phase-2",
    });
    return { action: "created" as const, name, enabled };
  },
});

/** Public read for CLI debugging — `convex run feature_flags:listFlags`. */
export const listFlags = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("feature_flags").collect();
    return rows.map((r) => ({
      name: r.name,
      enabled: r.enabled,
      updated_at: r.updated_at,
      updated_by: r.updated_by,
    }));
  },
});
