import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { remusStockReview, REMUS_OFFERS, REMUS_STOCK_SOURCE } from "../lib/remus_stock_review";
import { patchProduct } from "../lib/product_context";
import { patchStockInput } from "../lib/stock_input_writes";

export const apply=internalMutation({args:{dryRun:v.optional(v.boolean())},handler:async(ctx,{dryRun=true})=>{
  // Maintenance only: 108 masters at review; refuse growth beyond this bound.
  // All 22 offering reads use their account/product index.
  const items=await ctx.db.query("items").take(151);
  if(items.length===151)throw Error("Review the master inventory audit bound");
  const rows=await Promise.all(REMUS_OFFERS.map(([account,id])=>ctx.db.query("hygglo_products").withIndex("by_account_product",q=>q.eq("accountSlug",account).eq("productId",id)).first()));
  if(rows.some(row=>!row))throw Error("A reviewed Remus offer disappeared");
  const products=rows.filter((row):row is NonNullable<typeof row>=>row!==null);
  const plan=remusStockReview(items,products);
  if(!dryRun){
    for(const row of plan.items)await patchStockInput(ctx,row.id,{...row.patch,updated_at:Date.now()});
    for(const row of plan.products)await patchProduct(ctx,row.id,row.patch,products.find(p=>p._id===row.id)!);
    if(plan.items.length || plan.products.length)await ctx.db.insert("audit_log",{table_name:"items/hygglo_products",actor:"catalogue-audit",op:"update",count:plan.items.length+plan.products.length,source_file:"seed/remus_stock_review.apply",note:REMUS_STOCK_SOURCE,ts:Date.now()});
  }
  return {dryRun,source:REMUS_STOCK_SOURCE,reviewedOffers:products.length,itemWrites:plan.items.length,productWrites:plan.products.length,rentalChanges:0,messagesSent:0};
}});
