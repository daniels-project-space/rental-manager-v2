import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Stage 2.5: historical_revenue table — v1 static data imported at migration time.
 * v2 runtime reads from this table; no reference to v1 source files.
 *
 * Rows with total_revenue_gbp = 0 are "damage-only" sentinels:
 * they add damageCosts to the chart without overriding tracked reservation revenue.
 *
 * Rows with total_revenue_gbp > 0 are "full override" months (2022-08 through 2024-07)
 * where v1 tracked combined revenue across Daniel + Vertus + DB Cinema accounts,
 * and v1 Postgres rental table data is incomplete for that period.
 */

/** Upsert a single month's historical record. Idempotent — skips if month already exists. */
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
      return { status: "skipped", id: existing._id };
    }
    const id = await ctx.db.insert("historical_revenue", {
      month: args.month,
      total_revenue_gbp: args.total_revenue_gbp,
      damage_costs_gbp: args.damage_costs_gbp,
      business_expenses_gbp: args.business_expenses_gbp,
      total_overall_made_gbp: args.total_overall_made_gbp,
      source: args.source,
      created_at: Date.now(),
    });
    return { status: "inserted", id };
  },
});

/** Get all historical revenue rows ordered by month. */
export const getAll = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("historical_revenue").collect();
    return rows.sort((a, b) => a.month.localeCompare(b.month));
  },
});

/** Get a single month's row, or null. */
export const getByMonth = query({
  args: { month: v.string() },
  handler: async (ctx, { month }) => {
    return await ctx.db
      .query("historical_revenue")
      .withIndex("by_month", (q) => q.eq("month", month))
      .first();
  },
});

/**
 * Build the damage-overlay map consumed by revenue:getLifetimeByMonth.
 * Returns { [month: string]: number } — damage_costs_gbp for every row in the table.
 * Replaces the HIST_DAMAGE inline constant in revenue.ts.
 */
export const getDamageOverlayMap = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("historical_revenue").collect();
    const map: Record<string, number> = {};
    for (const row of rows) {
      if (row.damage_costs_gbp > 0) {
        map[row.month] = row.damage_costs_gbp;
      }
    }
    return map;
  },
});

/**
 * Get full-override months (total_revenue_gbp > 0): 2022-08 through 2024-07.
 * These replace reservation-table revenue for that period (Daniel + Vertus accounts
 * were not tracked in v1 Postgres — only DB Cinema was).
 */
export const getFullOverrideMonths = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("historical_revenue").collect();
    return rows
      .filter((r) => r.total_revenue_gbp > 0)
      .sort((a, b) => a.month.localeCompare(b.month));
  },
});
