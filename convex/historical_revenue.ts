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
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("historical_revenue")
      .withIndex("by_month", (q) => q.eq("month", args.month))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        total_revenue_gbp: args.total_revenue_gbp,
        damage_costs_gbp: args.damage_costs_gbp,
        business_expenses_gbp: args.business_expenses_gbp,
        total_overall_made_gbp: args.total_overall_made_gbp,
        source: args.source,
      });
      return { action: "updated", month: args.month };
    }
    await ctx.db.insert("historical_revenue", {
      ...args,
      created_at: Date.now(),
    });
    return { action: "inserted", month: args.month };
  },
});

/** List all historical revenue rows ordered by month. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("historical_revenue").collect();
  },
});
