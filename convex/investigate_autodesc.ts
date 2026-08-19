import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Dump every remaining `auto:desc` override with its listing title, so each can
 * be reviewed by hand against master inventory. The automated matcher is banned
 * from writing here, so this only GATHERS — no scoring, no proposals.
 */
export const dump = internalQuery({
  args: {},
  handler: async (ctx) => {
    const items = await ctx.db.query("items").collect();
    const byId = new Map(items.map((i) => [String(i._id), i]));
    const overrides = await ctx.db.query("listing_resolution_override").collect();

    const rows = [];
    for (const o of overrides) {
      if (!o.note?.startsWith("auto:desc")) continue;
      const prod = await ctx.db
        .query("hygglo_products")
        .withIndex("by_account_product", (q) =>
          q.eq("accountSlug", o.account_slug).eq("productId", o.product_id),
        )
        .first();
      rows.push({
        key: `${o.account_slug}#${o.product_id}`,
        title: (prod?.name ?? "(no title)").slice(0, 95),
        holds: o.components.map((c) => {
          const it = byId.get(String(c.item_id));
          return `${c.qty}x ${it?.name_canonical ?? "?"}${it?.is_marketing_only ? " [MKT]" : ""}`;
        }),
      });
    }
    return rows.sort((a, b) => a.key.localeCompare(b.key));
  },
});

export default internalAction({
  handler: async (ctx): Promise<unknown> =>
    ctx.runQuery(internal.investigate_autodesc.dump, {}),
});
