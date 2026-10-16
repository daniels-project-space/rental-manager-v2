import { paginationOptsValidator } from "convex/server";
import { internalMutation, internalQuery } from "./_generated/server";
import { projectProduct, refreshProductContext } from "./lib/product_context";

/** Operator migration: one checkpointed page, derived records only. */
export const backfill = internalMutation({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    if (paginationOpts.numItems < 1 || paginationOpts.numItems > 50) throw new Error("Product context page must contain 1–50 source records");
    const page = await ctx.db.query("hygglo_products").paginate(paginationOpts);
    const keys = new Map(page.page.map((row) => [`${row.accountSlug}#${row.productId}`, row]));
    const counts = { inserted: 0, updated: 0, unchanged: 0 };
    for (const row of keys.values()) counts[await refreshProductContext(ctx, row.accountSlug, row.productId)]++;
    return { ...counts, scanned: page.page.length, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/** Read-only verification against actual indexed .first() source semantics. */
export const audit = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    if (paginationOpts.numItems < 1 || paginationOpts.numItems > 50) throw new Error("Product context audit must contain 1–50 source records");
    const page = await ctx.db.query("hygglo_products").paginate(paginationOpts);
    const keys = new Map(page.page.map((row) => [`${row.accountSlug}#${row.productId}`, row]));
    const mismatches: Array<{ account: string; productId: number; fields: string[] }> = [];
    for (const row of keys.values()) {
      const [source, compact] = await Promise.all([
        ctx.db.query("hygglo_products").withIndex("by_account_product", (q) => q.eq("accountSlug", row.accountSlug).eq("productId", row.productId)).first(),
        ctx.db.query("hygglo_product_context").withIndex("by_account_product", (q) => q.eq("account_slug", row.accountSlug).eq("product_id", row.productId)).first(),
      ]);
      if (!source) throw new Error("Product audit lost a source inside its snapshot");
      const expected = projectProduct(source);
      const fields = Object.entries(expected).filter(([key, value]) =>
        !compact || JSON.stringify(compact[key as keyof typeof compact]) !== JSON.stringify(value)).map(([key]) => key);
      if (fields.length) mismatches.push({ account: row.accountSlug, productId: row.productId, fields });
    }
    return { scanned: page.page.length, checkedKeys: keys.size, mismatches, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
