import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/** Hygglo's real multi-day tier table for a listing (what the renter pays). */
export const show = internalQuery({
  args: { account_slug: v.string(), product_ids: v.array(v.number()) },
  handler: async (ctx, { account_slug, product_ids }) => {
    const out: Array<Record<string, unknown>> = [];
    for (const pid of product_ids) {
      const hp = await ctx.db
        .query("hygglo_products")
        .withIndex("by_account_product", (q) =>
          q.eq("accountSlug", account_slug).eq("productId", pid),
        )
        .unique();
      out.push({
        product_id: pid,
        name: (hp?.name ?? "").slice(0, 46),
        prices: hp?.prices ?? null,
      });
    }
    return out;
  },
});

export default internalAction({
  args: { account_slug: v.string(), product_ids: v.array(v.number()) },
  handler: async (ctx, a): Promise<unknown> =>
    ctx.runQuery(internal.diag_price_tiers.show, a),
});
