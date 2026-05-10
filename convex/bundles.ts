import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Stage 2.5: bundle definitions now read from Convex bundles + bundle_items tables.
 * The inline BUNDLE_DEFINITIONS constant has been deleted — no static data in code.
 */

function matchToBundle(
  itemNames: string[],
  bundles: Array<{ name: string; items: string[] }>
): string | null {
  const freq = new Map<string, number>();
  for (const name of itemNames) {
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  let bestMatch: string | null = null;
  let bestLength = 0;
  const sorted = [...bundles].sort((a, b) => b.items.length - a.items.length);
  for (const bundle of sorted) {
    const required = new Map<string, number>();
    for (const item of bundle.items) {
      const key = item.toLowerCase().replace(/[^a-z0-9]/g, "");
      required.set(key, (required.get(key) ?? 0) + 1);
    }
    let matches = true;
    for (const [reqKey, count] of required.entries()) {
      let found = 0;
      for (const [rKey, rCount] of freq.entries()) {
        if (rKey.includes(reqKey) || reqKey.includes(rKey)) found += rCount;
      }
      if (found < count) { matches = false; break; }
    }
    if (matches && bundle.items.length > bestLength) {
      bestMatch = bundle.name;
      bestLength = bundle.items.length;
    }
  }
  return bestMatch;
}

export const getTopBundles = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.number(),
  },
  handler: async (ctx, { accountSlug, days }) => {
    // Load bundle definitions from Convex tables (replaces inline BUNDLE_DEFINITIONS)
    const bundleRows = await ctx.db.query("bundles").collect();
    const bundleItemRows = await ctx.db.query("bundle_items").collect();

    // Build { name, items[] } map from Convex rows
    const itemsByBundleId = new Map<string, string[]>();
    for (const bi of bundleItemRows) {
      const existing = itemsByBundleId.get(bi.bundle_id) ?? [];
      for (let i = 0; i < (bi.qty ?? 1); i++) {
        existing.push(bi.item_name_canonical);
      }
      itemsByBundleId.set(bi.bundle_id, existing);
    }
    const bundleDefs = bundleRows.map((b) => ({
      name: b.bundle_name,
      items: itemsByBundleId.get(b._id) ?? [],
    }));

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }
    reservations = reservations.filter(
      (r) => r.status !== "cancelled" && r.status !== "denied" && (r.items ?? []).length >= 2
    );
    const byBundle = new Map<string, { revenue: number; count: number; totalDays: number; items: string[] }>();
    for (const res of reservations) {
      const itemNames = (res.items ?? []).map((i: { item_name: string }) => i.item_name);
      if (itemNames.length < 2) continue;
      const bundleName = matchToBundle(itemNames, bundleDefs);
      if (!bundleName) continue;
      const gross = res.gross_paid_gbp ?? 0;
      const dur = res.duration_days ?? 0;
      const existing = byBundle.get(bundleName) ?? {
        revenue: 0, count: 0, totalDays: 0,
        items: bundleDefs.find((b) => b.name === bundleName)?.items ?? [],
      };
      existing.revenue += gross;
      existing.count += 1;
      existing.totalDays += dur;
      byBundle.set(bundleName, existing);
    }
    return Array.from(byBundle.entries())
      .map(([name, stats]) => ({
        name,
        totalRevenue: Math.round(stats.revenue * 100) / 100,
        rentalCount: stats.count,
        totalDays: stats.totalDays,
        avgValue: stats.count > 0 ? Math.round((stats.revenue / stats.count) * 100) / 100 : 0,
        items: stats.items,
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);
  },
});

export const getBundleRevenueRanking = getTopBundles;
