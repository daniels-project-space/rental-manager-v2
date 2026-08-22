import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * Does the cached listing price still match Hygglo's live 1-day rate?
 *
 * `online_listings.daily_price` is only refreshed by a manual "Rescan
 * listings" click, while `hygglo_products.prices` is synced daily by
 * catalog-sync. The renter-facing tools read the CACHED one, so every
 * disagreement here is a wrong number quoted to a renter.
 */
export const check = internalQuery({
  args: { account_slug: v.string() },
  handler: async (ctx, { account_slug }) => {
    const listings = await ctx.db
      .query("online_listings")
      .withIndex("by_account", (q) => q.eq("account_slug", account_slug))
      .collect();
    const byPid = new Map(
      (await ctx.db.query("hygglo_products").collect())
        .filter((p) => p.accountSlug === account_slug)
        .map((p) => [p.productId, p]),
    );

    let agree = 0;
    let cachedMissing = 0;
    let liveMissing = 0;
    const drift: Array<{ product_id: number; cached: number; live: number; name: string }> = [];
    for (const l of listings) {
      const hp = byPid.get(l.product_id);
      const live = (hp?.prices ?? []).find((p) => p.days === 1)?.pricePerDay ?? null;
      const cached = l.daily_price ?? null;
      if (live == null) {
        liveMissing++;
        continue;
      }
      if (cached == null) {
        cachedMissing++;
        continue;
      }
      if (Math.round(cached) === Math.round(live)) agree++;
      else
        drift.push({
          product_id: l.product_id,
          cached,
          live,
          name: (l.name ?? "").slice(0, 40),
        });
    }
    return {
      account_slug,
      listings: listings.length,
      agree,
      disagree: drift.length,
      cached_missing: cachedMissing,
      live_missing: liveMissing,
      worst: drift
        .sort((a, b) => Math.abs(b.live - b.cached) - Math.abs(a.live - a.cached))
        .slice(0, 10),
    };
  },
});

export default internalAction({
  args: { account_slug: v.string() },
  handler: async (ctx, a): Promise<unknown> =>
    ctx.runQuery(internal.diag_price_staleness.check, a),
});
