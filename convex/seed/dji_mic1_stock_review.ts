import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { djiMic1StockReview, DJI_MIC1_REVIEW_SOURCE } from "../lib/dji_mic1_stock_review";
import { insertStockInput, patchStockInput } from "../lib/stock_input_writes";
import { patchProduct } from "../lib/product_context";

export const apply = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun = true }) => {
    const account = "dbcinema", productId = 852812;
    const [masterRows, secondGenRows, staleRows, rodeRows, product, overrideRows] = await Promise.all([
      ctx.db.query("items").withIndex("by_canonical_name", q => q.eq("name_canonical", "DJI Wireless Mics")).take(2),
      ctx.db.query("items").withIndex("by_canonical_name", q => q.eq("name_canonical", "DJI Mic 2 wireless")).take(2),
      ctx.db.query("items").withIndex("by_canonical_name", q => q.eq("name_canonical", "Audio boom mic Sennheiser")).take(2),
      ctx.db.query("items").withIndex("by_canonical_name", q => q.eq("name_canonical", "Rode Video Mic Go")).take(2),
      ctx.db.query("hygglo_products").withIndex("by_account_product", q => q.eq("accountSlug", account).eq("productId", productId)).first(),
      ctx.db.query("listing_resolution_override").withIndex("by_account_product", q => q.eq("account_slug", account).eq("product_id", productId)).take(2),
    ]);
    const items = [...masterRows, ...secondGenRows, ...staleRows, ...rodeRows];
    if (!product) throw Error("The owner-confirmed DJI Mic 1 offer disappeared");
    const plan = djiMic1StockReview(items, [product], overrideRows);
    if (!dryRun) {
      for (const row of plan.items) await patchStockInput(ctx, row.id, { ...row.patch, updated_at: Date.now() });
      for (const row of plan.products) await patchProduct(ctx, row.id, row.patch, product);
      for (const row of plan.mappingChanges) await patchStockInput(ctx, row.id, { ...row.patch, updated_at: Date.now() });
      for (const row of plan.inserts) await insertStockInput(ctx, "listing_resolution_override", { ...row, source: "manual_audit", note: DJI_MIC1_REVIEW_SOURCE, updated_at: Date.now() });
      const count = plan.items.length + plan.products.length + plan.mappingChanges.length + plan.inserts.length;
      if (count) await ctx.db.insert("audit_log", { table_name: "items/hygglo_products/listing_resolution_override", actor: "catalogue-audit", op: "update", count, source_file: "seed/dji_mic1_stock_review.apply", note: DJI_MIC1_REVIEW_SOURCE, ts: Date.now() });
    }
    return { dryRun, reviewedOffers: 1, itemWrites: plan.items.length, productWrites: plan.products.length, mappingWrites: plan.mappingChanges.length + plan.inserts.length, ownedQuantityChanged: false, rentalChanges: 0, messagesSent: 0, packingReviewRequired: true };
  },
});
