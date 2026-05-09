import { query } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

/**
 * W11 Top Bundles - ranked by revenue using reservations.bundle_id FK
 */
export const getBundleRevenueRanking = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.number(),
  },
  handler: async (ctx, { accountSlug, days }) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // Only reservations with a bundle_id (sparse — expected per resolutions)
    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    reservations = reservations.filter((r) => r.bundle_id !== undefined);
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }

    // Aggregate by bundle_id
    const bundleMap = new Map<string, { totalRevenue: number; rentalCount: number }>();
    for (const r of reservations) {
      const key = r.bundle_id as string;
      const existing = bundleMap.get(key) ?? { totalRevenue: 0, rentalCount: 0 };
      existing.totalRevenue += r.gross_paid_gbp ?? 0;
      existing.rentalCount += 1;
      bundleMap.set(key, existing);
    }

    // Resolve bundle names and constituent items
    const results = await Promise.all(
      Array.from(bundleMap.entries()).map(async ([bundleId, stats]) => {
        const bundle = await ctx.db
          .query("bundles")
          .withIndex("by_slug", (q) => q.eq("slug", bundleId))
          .first();
        // Fall back to direct id lookup
        const bundleDoc = bundle ?? await ctx.db.get(bundleId as Id<"bundles">);
        if (!bundleDoc) return null;

        const bundleItems = await ctx.db
          .query("bundle_items")
          .withIndex("by_bundle", (q) => q.eq("bundle_id", bundleDoc._id))
          .collect();

        return {
          bundleId: bundleDoc._id,
          name: bundleDoc.bundle_name,
          totalRevenue: stats.totalRevenue,
          rentalCount: stats.rentalCount,
          itemNames: bundleItems.map((bi) => bi.item_name_canonical),
        };
      })
    );

    return results
      .filter((r) => r !== null)
      .sort((a, b) => b!.totalRevenue - a!.totalRevenue);
  },
});
