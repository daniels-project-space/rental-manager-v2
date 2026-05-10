import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * W17 Price Recommendations — apply a suggested rate to pricing_catalog.
 * Updates daily_price_min and daily_price_max on the matching pricing_catalog row.
 */
export const applyRecommendation = mutation({
  args: {
    itemNameCanonical: v.string(),
    newDailyRate: v.number(),
  },
  handler: async (ctx, { itemNameCanonical, newDailyRate }) => {
    if (newDailyRate <= 0) throw new Error("newDailyRate must be positive");

    const rows = await ctx.db
      .query("pricing_catalog")
      .withIndex("by_name", (q) => q.eq("item_name_canonical", itemNameCanonical))
      .collect();

    if (rows.length === 0) {
      throw new Error(`No pricing_catalog row found for: ${itemNameCanonical}`);
    }

    for (const row of rows) {
      // Keep price_max >= price_min; if new rate > existing max, bump max too
      const newMax = Math.max(row.daily_price_max, newDailyRate);
      await ctx.db.patch(row._id, {
        daily_price_min: newDailyRate,
        daily_price_max: newMax,
      });
    }

    // Remove any existing dismissal for this item (applying overrides dismiss)
    const existing = await ctx.db
      .query("recommendation_dismissals")
      .withIndex("by_item_name", (q) => q.eq("item_name_canonical", itemNameCanonical))
      .first();
    if (existing) await ctx.db.delete(existing._id);

    return { ok: true, updated: rows.length, newDailyRate };
  },
});

/**
 * W17 Price Recommendations — dismiss a recommendation.
 * Stores a dismissal record so the item is hidden from the recommendations list.
 */
export const dismissRecommendation = mutation({
  args: {
    itemNameCanonical: v.string(),
    itemId: v.optional(v.string()),   // Convex ID as string (optional)
  },
  handler: async (ctx, { itemNameCanonical }) => {
    // Idempotent: skip if already dismissed
    const existing = await ctx.db
      .query("recommendation_dismissals")
      .withIndex("by_item_name", (q) => q.eq("item_name_canonical", itemNameCanonical))
      .first();
    if (existing) return { ok: true, already_dismissed: true };

    await ctx.db.insert("recommendation_dismissals", {
      item_name_canonical: itemNameCanonical,
      dismissed_at: Date.now(),
      dismissed_by: "user",
    });
    return { ok: true, already_dismissed: false };
  },
});

/**
 * Query dismissed item names (used by W17 to filter recommendations list).
 */
export const getDismissedItemNames = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("recommendation_dismissals").collect();
    return rows.map((r) => r.item_name_canonical);
  },
});

// B-3: fuzzy lookup for dashboard chat tool
export const lookup = query({
  args: { item_name: v.string() },
  handler: async (ctx, { item_name }) => {
    const allRows = await ctx.db.query("pricing_catalog").collect();
    function norm(s: string): string {
      return s.toLowerCase().replace(/[^a-z0-9]/g, "");
    }
    const q = norm(item_name);
    const scored = allRows
      .filter((r) => !r.is_bundle && !r.marketing_only)
      .map((r) => {
        const cn = norm(r.item_name_canonical);
        const score =
          cn === q ? 3 : cn.includes(q) ? 2 : q.includes(cn) && cn.length > 3 ? 1 : 0;
        return { row: r, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.row.item_name_canonical.length - a.row.item_name_canonical.length);
    return scored.map((x) => x.row).slice(0, 5);
  },
});
