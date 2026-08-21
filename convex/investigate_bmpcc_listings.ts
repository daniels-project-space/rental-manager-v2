import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

export const probe = internalQuery({
  args: {},
  handler: async (ctx) => {
    const items = (await ctx.db.query("items").collect()).filter((i) =>
      /bmpcc/i.test(i.name_canonical),
    );
    const out = [];
    for (const it of items) {
      const idx = await ctx.db
        .query("hygglo_product_index")
        .withIndex("by_item_id", (q) => q.eq("item_id", it._id))
        .collect();
      const listings = [];
      for (const r of idx) {
        const l = await ctx.db
          .query("online_listings")
          .withIndex("by_account_product", (q) =>
            q.eq("account_slug", r.account_slug).eq("product_id", r.product_id),
          )
          .first();
        listings.push({
          account: r.account_slug,
          product_id: r.product_id,
          listing_name: l?.name ?? "(NO online_listings ROW)",
          price: l?.daily_price ?? null,
          has_description: !!l?.description,
          description_preview: (l?.description ?? "").slice(0, 140),
        });
      }
      out.push({ item: it.name_canonical, qty: it.qty, index_rows: idx.length, listings });
    }
    return out;
  },
});

export default internalAction({
  handler: async (ctx): Promise<unknown> =>
    ctx.runQuery(internal.investigate_bmpcc_listings.probe, {}),
});
