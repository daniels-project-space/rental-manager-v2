import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** All audit-authoritative listing→item overrides (for the resolver maps). */
export const getAll = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("listing_resolution_override").collect();
    return rows.map((r) => ({
      account_slug: r.account_slug,
      product_id: r.product_id,
      components: r.components.map((c) => ({ item_id: String(c.item_id), qty: c.qty })),
      note: r.note ?? null,
    }));
  },
});

/** Pin a Hygglo listing (account#product_id) to its true item composition. */
export const setOverride = mutation({
  args: {
    account_slug: v.string(),
    product_id: v.number(),
    components: v.array(v.object({ item_id: v.id("items"), qty: v.number() })),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("listing_resolution_override")
      .withIndex("by_account_product", (q) =>
        q.eq("account_slug", args.account_slug).eq("product_id", args.product_id),
      )
      .first();
    const doc = {
      account_slug: args.account_slug,
      product_id: args.product_id,
      components: args.components,
      note: args.note,
      source: "manual_audit",
      updated_at: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return { updated: 1, product_id: args.product_id };
    }
    await ctx.db.insert("listing_resolution_override", doc);
    return { inserted: 1, product_id: args.product_id };
  },
});

export const remove = mutation({
  args: { account_slug: v.string(), product_id: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("listing_resolution_override")
      .withIndex("by_account_product", (q) =>
        q.eq("account_slug", args.account_slug).eq("product_id", args.product_id),
      )
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
      return { deleted: 1 };
    }
    return { deleted: 0 };
  },
});
