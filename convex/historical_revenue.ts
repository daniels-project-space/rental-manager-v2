import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Upsert a single historical revenue month (idempotent by month key). */
export const upsertMonth = mutation({
  args: {
    month: v.string(),
    total_revenue_gbp: v.number(),
    damage_costs_gbp: v.number(),
    business_expenses_gbp: v.number(),
    total_overall_made_gbp: v.number(),
    source: v.string(),
    // Per-account splits (v1 algorithm port)
    dbcinema_revenue_gbp: v.optional(v.number()),
    leo_revenue_gbp: v.optional(v.number()),
    daniel_revenue_gbp: v.optional(v.number()),
    vertus_revenue_gbp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("historical_revenue")
      .withIndex("by_month", (q) => q.eq("month", args.month))
      .first();
    const patch = {
      total_revenue_gbp: args.total_revenue_gbp,
      damage_costs_gbp: args.damage_costs_gbp,
      business_expenses_gbp: args.business_expenses_gbp,
      total_overall_made_gbp: args.total_overall_made_gbp,
      source: args.source,
      ...(args.dbcinema_revenue_gbp !== undefined && { dbcinema_revenue_gbp: args.dbcinema_revenue_gbp }),
      ...(args.leo_revenue_gbp !== undefined && { leo_revenue_gbp: args.leo_revenue_gbp }),
      ...(args.daniel_revenue_gbp !== undefined && { daniel_revenue_gbp: args.daniel_revenue_gbp }),
      ...(args.vertus_revenue_gbp !== undefined && { vertus_revenue_gbp: args.vertus_revenue_gbp }),
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return { action: "updated", month: args.month };
    }
    await ctx.db.insert("historical_revenue", {
      ...patch,
      month: args.month,
      created_at: Date.now(),
    });
    return { action: "inserted", month: args.month };
  },
});

/**
 * Patch ONLY leo_revenue_gbp on an existing historical_revenue row.
 * Used by backfill-leo-from-hygglo-direct.mjs to fix v1's incomplete leo import
 * without touching dbcinema/daniel/vertus values for the same month.
 * If the row doesn't exist, inserts a minimal row with zeros for other fields.
 */
export const patchLeoMonth = mutation({
  args: {
    month: v.string(),
    leo_revenue_gbp: v.number(),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("historical_revenue")
      .withIndex("by_month", (q) => q.eq("month", args.month))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        leo_revenue_gbp: args.leo_revenue_gbp,
        ...(args.source && { source: args.source }),
      });
      return { action: "updated", month: args.month, leo_revenue_gbp: args.leo_revenue_gbp };
    }
    await ctx.db.insert("historical_revenue", {
      month: args.month,
      total_revenue_gbp: 0,
      damage_costs_gbp: 0,
      business_expenses_gbp: 0,
      total_overall_made_gbp: 0,
      source: args.source ?? "hygglo-direct-leo-only",
      leo_revenue_gbp: args.leo_revenue_gbp,
      created_at: Date.now(),
    });
    return { action: "inserted", month: args.month, leo_revenue_gbp: args.leo_revenue_gbp };
  },
});

/**
 * Patch ONLY dbcinema_revenue_gbp on an existing historical_revenue row.
 * Used by backfill-dbcinema-from-hygglo-direct.mjs to fix v1's incomplete dbcinema import
 * without touching leo/daniel/vertus values for the same month.
 * If the row doesn't exist, inserts a minimal row with zeros for other fields.
 */
export const patchDbcinemaMonth = mutation({
  args: {
    month: v.string(),
    dbcinema_revenue_gbp: v.number(),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("historical_revenue")
      .withIndex("by_month", (q) => q.eq("month", args.month))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        dbcinema_revenue_gbp: args.dbcinema_revenue_gbp,
        ...(args.source && { source: args.source }),
      });
      return { action: "updated", month: args.month, dbcinema_revenue_gbp: args.dbcinema_revenue_gbp };
    }
    await ctx.db.insert("historical_revenue", {
      month: args.month,
      total_revenue_gbp: 0,
      damage_costs_gbp: 0,
      business_expenses_gbp: 0,
      total_overall_made_gbp: 0,
      source: args.source ?? "hygglo-direct-dbcinema-only",
      dbcinema_revenue_gbp: args.dbcinema_revenue_gbp,
      created_at: Date.now(),
    });
    return { action: "inserted", month: args.month, dbcinema_revenue_gbp: args.dbcinema_revenue_gbp };
  },
});

/** List all historical revenue rows ordered by month. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("historical_revenue").collect();
  },
});
