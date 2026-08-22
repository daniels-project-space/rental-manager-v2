import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { tierRateForDays } from "./lib/hygglo_pricing";

/**
 * How much of the Hygglo multi-day price table do we actually hold?
 *
 * The renter pays a per-day rate that drops at 3 and 7 days, and those tiers
 * differ per listing AND per account. Anywhere the tier table is missing we
 * fall back to the 1-day rate times the day count, which OVERSTATES every
 * longer booking — quoting more than Hygglo would actually charge.
 *
 * Read-only. Measures per account: listings, how many have a synced catalog
 * row, how many carry a usable tier table, and how many carry the 3- and
 * 7-day tiers specifically.
 */
export const check = internalQuery({
  args: { account_slug: v.string() },
  handler: async (ctx, { account_slug }) => {
    const listings = await ctx.db
      .query("online_listings")
      .withIndex("by_account", (q) => q.eq("account_slug", account_slug))
      .collect();
    const products = await ctx.db.query("hygglo_products").collect();
    const byPid = new Map(
      products
        .filter((p) => p.accountSlug === account_slug)
        .map((p) => [p.productId, p]),
    );

    let noCatalogRow = 0;
    let noTiers = 0;
    let has3 = 0;
    let has7 = 0;
    let usable = 0;
    const missing: Array<{ product_id: number; name: string; price: number | null }> = [];
    for (const l of listings) {
      const hp = byPid.get(l.product_id);
      if (!hp) {
        noCatalogRow++;
        missing.push({
          product_id: l.product_id,
          name: (l.name ?? "").slice(0, 44),
          price: l.daily_price ?? null,
        });
        continue;
      }
      const tiers = (hp.prices ?? []) as Array<{ days?: number; pricePerDay?: number }>;
      const ok = tiers.some(
        (t) => typeof t.days === "number" && typeof t.pricePerDay === "number" && t.pricePerDay > 0,
      );
      if (!ok) {
        noTiers++;
        missing.push({
          product_id: l.product_id,
          name: (l.name ?? "").slice(0, 44),
          price: l.daily_price ?? null,
        });
        continue;
      }
      usable++;
      if (tierRateForDays(tiers, 3) !== tierRateForDays(tiers, 1)) has3++;
      if (tierRateForDays(tiers, 7) !== tierRateForDays(tiers, 3)) has7++;
    }
    return {
      account_slug,
      listings: listings.length,
      usable_tier_table: usable,
      no_catalog_row: noCatalogRow,
      catalog_row_but_no_tiers: noTiers,
      distinct_3day_rate: has3,
      distinct_7day_rate: has7,
      sample_missing: missing.slice(0, 12),
    };
  },
});

export default internalAction({
  args: { account_slug: v.string() },
  handler: async (ctx, a): Promise<unknown> =>
    ctx.runQuery(internal.diag_tier_coverage.check, a),
});
