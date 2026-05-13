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
// Uses 3-tier resolver mirroring convex/calendar.ts findItemByName:
//   Tier 1: exact canonical match on pricing_catalog.item_name_canonical
//   Tier 2: exact alias match via items table (aliases field)
//   Tier 3: substring match (canonical or alias, min 5 chars)
export const lookup = query({
  args: { item_name: v.string() },
  handler: async (ctx, { item_name }) => {
    const lower = item_name.toLowerCase().trim();

    // ── Tier 1: exact canonical match ────────────────────────────────────
    const exactRows = await ctx.db
      .query("pricing_catalog")
      .withIndex("by_name", (q) => q.eq("item_name_canonical", item_name))
      .collect();
    const exactRowsCI = exactRows.length > 0
      ? exactRows
      : (await ctx.db.query("pricing_catalog").collect()).filter(
          (r) => !r.is_bundle && !r.marketing_only && r.item_name_canonical.toLowerCase() === lower
        );
    if (exactRowsCI.length > 0) return exactRowsCI.slice(0, 5);

    // ── Resolve via items table (has aliases) ────────────────────────────
    const allItems = await ctx.db.query("items").collect();

    function findItemByName(name: string) {
      const q = name.toLowerCase().trim();
      // T1: exact canonical
      let m = allItems.find((i) => (i.name_canonical ?? "").toLowerCase() === q);
      if (m) return m;
      // T2: exact alias
      m = allItems.find((i) => (i.aliases ?? []).some((a: string) => a.toLowerCase() === q));
      if (m) return m;
      // T3: substring (min 5 chars)
      if (q.length >= 5) {
        m = allItems.find((i) => {
          const canon = (i.name_canonical ?? "").toLowerCase();
          return canon && (canon.includes(q) || q.includes(canon));
        });
        if (m) return m;
        m = allItems.find((i) =>
          (i.aliases ?? []).some((a: string) => {
            const al = a.toLowerCase();
            return al.length >= 5 && (al.includes(q) || q.includes(al));
          })
        );
        if (m) return m;
      }
      return null;
    }

    const resolvedItem = findItemByName(item_name);
    if (resolvedItem) {
      // Look up pricing_catalog by the resolved canonical name
      const resolvedRows = await ctx.db
        .query("pricing_catalog")
        .withIndex("by_name", (q) => q.eq("item_name_canonical", resolvedItem.name_canonical))
        .collect();
      const filtered = resolvedRows.filter((r) => !r.is_bundle && !r.marketing_only);
      if (filtered.length > 0) return filtered.slice(0, 5);
      // Also try case-insensitive fallback
      const allPricing = await ctx.db.query("pricing_catalog").collect();
      const ciMatch = allPricing.filter(
        (r) => !r.is_bundle && !r.marketing_only &&
          r.item_name_canonical.toLowerCase() === (resolvedItem.name_canonical ?? "").toLowerCase()
      );
      if (ciMatch.length > 0) return ciMatch.slice(0, 5);
    }

    // ── Tier 3 fallback: substring on pricing_catalog directly ───────────
    if (lower.length >= 5) {
      const allRows = await ctx.db.query("pricing_catalog").collect();
      const scored = allRows
        .filter((r) => !r.is_bundle && !r.marketing_only)
        .map((r) => {
          const cn = r.item_name_canonical.toLowerCase();
          const score = cn === lower ? 3 : cn.includes(lower) ? 2 : lower.includes(cn) && cn.length > 3 ? 1 : 0;
          return { row: r, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.row.item_name_canonical.length - b.row.item_name_canonical.length);
      return scored.map((x) => x.row).slice(0, 5);
    }

    return [];
  },
});
