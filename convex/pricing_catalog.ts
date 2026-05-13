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
// 3-tier resolver:
//   Tier 1: exact canonical match on pricing_catalog.item_name_canonical (case-insensitive)
//   Tier 2: exact alias match via items table
//   Tier 3: substring match on canonical name or alias (min 5 chars)
export const lookup = query({
  args: { item_name: v.string() },
  handler: async (ctx, { item_name }) => {
    const lower = item_name.toLowerCase().trim();

    // ── Tier 1: exact canonical match on pricing_catalog ─────────────────
    const exactRows = await ctx.db
      .query("pricing_catalog")
      .withIndex("by_name", (q) => q.eq("item_name_canonical", item_name))
      .collect();
    const exactRowsCI =
      exactRows.length > 0
        ? exactRows
        : (await ctx.db.query("pricing_catalog").collect()).filter(
            (r) => !r.is_bundle && !r.marketing_only && r.item_name_canonical.toLowerCase() === lower,
          );
    if (exactRowsCI.length > 0) return exactRowsCI.slice(0, 5);

    // ── Tier 2 + 3: resolve via items table (has aliases) ────────────────
    const allItems = await ctx.db.query("items").collect();

    function findItemByName(name: string): { name_canonical?: string } | null {
      const q = name.toLowerCase().trim();
      // T1: exact canonical
      let m: { name_canonical?: string; aliases?: string[] } | undefined = allItems.find(
        (i) => (i.name_canonical ?? "").toLowerCase() === q,
      );
      if (m) return m;
      // T2: exact alias
      m = allItems.find((i) =>
        (i.aliases ?? []).some((a: string) => a.toLowerCase() === q),
      );
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
          }),
        );
        if (m) return m;
      }
      return null;
    }

    const resolvedItem = findItemByName(item_name);
    if (!resolvedItem?.name_canonical) return [];

    // Look up pricing_catalog by the resolved canonical name
    const resolvedCanon = resolvedItem.name_canonical;
    const resolvedRows = await ctx.db
      .query("pricing_catalog")
      .withIndex("by_name", (q) => q.eq("item_name_canonical", resolvedCanon))
      .collect();
    const filtered = resolvedRows.filter((r) => !r.is_bundle && !r.marketing_only);
    if (filtered.length > 0) return filtered.slice(0, 5);

    // Fallback: substring match on all pricing_catalog rows
    const allRows = await ctx.db.query("pricing_catalog").collect();
    const lq = lower.replace(/[^a-z0-9]/g, "");
    // First try non-bundle rows only
    const scoreRows = (rows: typeof allRows) =>
      rows
        .map((r) => {
          const cn = r.item_name_canonical.toLowerCase().replace(/[^a-z0-9]/g, "");
          const score = cn === lq ? 3 : cn.includes(lq) ? 2 : lq.includes(cn) && cn.length > 3 ? 1 : 0;
          return { row: r, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || b.row.item_name_canonical.length - a.row.item_name_canonical.length);

    const nonBundleScored = scoreRows(allRows.filter((r) => !r.is_bundle && !r.marketing_only));
    if (nonBundleScored.length > 0) return nonBundleScored.map((x) => x.row).slice(0, 5);

    // Fallback: include bundle rows if no non-bundle match found
    const bundleScored = scoreRows(allRows.filter((r) => !r.marketing_only));
    return bundleScored.map((x) => x.row).slice(0, 5);
  },
});

/**
 * Upsert a pricing_catalog row by canonical name.
 * Creates if not found; patches price fields if found.
 * Used for seeding body-only rates not captured from Hygglo kit listings.
 */
export const upsertPricingRow = mutation({
  args: {
    item_name_canonical: v.string(),
    daily_price_min: v.number(),
    daily_price_max: v.number(),
    is_bundle: v.optional(v.boolean()),
    category: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pricing_catalog")
      .withIndex("by_name", (q) => q.eq("item_name_canonical", args.item_name_canonical))
      .filter((q) => q.eq(q.field("is_bundle"), false))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        daily_price_min: args.daily_price_min,
        daily_price_max: args.daily_price_max,
      });
      return { ok: true, action: "updated" as const, id: existing._id };
    }

    const id = await ctx.db.insert("pricing_catalog", {
      item_name_canonical: args.item_name_canonical,
      daily_price_min: args.daily_price_min,
      daily_price_max: args.daily_price_max,
      is_bundle: args.is_bundle ?? false,
      category: args.category,
      marketing_only: false,
      created_at: Date.now(),
    });
    return { ok: true, action: "created" as const, id };
  },
});
