import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * Does the catalogue hold SINGLE-camera listings, or only bundles?
 *
 * A blocked shadow-eval reply was explained away as "the renter asked for one
 * A7III plus one A7V and the listing is a fixed 2x A7III pair, so there is no
 * grounded price". Daniel says that is wrong: individual listings exist. If so
 * the bot is anchoring on whichever listing the thread resolved to and treating
 * the catalogue as if it contained nothing else — a composition failure, not a
 * missing price.
 *
 * Lists every listing matching a model, with its price tiers and whether the
 * title looks like a multi-unit bundle, so the two cases can be told apart.
 */
const MULTI = /\b(\d+)\s*x\b|\btwo\b|\bpair\b|\bdual\b/i;

export const check = internalQuery({
  args: { patterns: v.array(v.string()) },
  handler: async (ctx, { patterns }) => {
    const products = await ctx.db.query("hygglo_products").take(4000);
    const res: Record<string, unknown[]> = {};
    for (const pat of patterns) {
      const re = new RegExp(pat, "i");
      res[pat] = products
        .filter((p) => re.test(p.name ?? ""))
        .map((p) => {
          const title = p.name ?? "";
          const m = title.match(MULTI);
          return {
            product_id: p.productId,
            account: p.accountSlug ?? "?",
            title: title.slice(0, 88),
            looks_multi_unit: !!m,
            unit_hint: m?.[1] ?? (m ? "two/pair" : null),
            published: p.isPublished ?? null,
            price_bands: Array.isArray(p.prices) ? p.prices.length : 0,
            cheapest_day_rate: Array.isArray(p.prices)
              ? Math.min(
                  ...p.prices
                    .map((x: { pricePerDay?: number }) => x.pricePerDay ?? Infinity)
                    .filter((n: number) => Number.isFinite(n)),
                )
              : null,
          };
        })
        .sort((a, b) => Number(a.looks_multi_unit) - Number(b.looks_multi_unit));
    }
    return { catalogue_size: products.length, matches: res };
  },
});

export default internalAction({
  args: { patterns: v.array(v.string()) },
  handler: async (ctx, args): Promise<unknown> =>
    ctx.runQuery(internal.diag_a7_listings.check, args),
});
