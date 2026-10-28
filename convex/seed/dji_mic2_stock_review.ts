import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { djiMic2StockReview, DJI_MIC2_OFFERS, DJI_MIC2_REVIEW_SOURCE } from "../lib/dji_mic2_stock_review";
import { patchProduct } from "../lib/product_context";
import { insertStockInput, patchStockInput } from "../lib/stock_input_writes";

export const apply=internalMutation({args:{dryRun:v.optional(v.boolean())},handler:async(ctx,{dryRun=true})=>{
  const items=await ctx.db.query("items").take(151);
  if(items.length===151)throw Error("Review the master inventory audit bound");
  const [rows,overrideRows]=await Promise.all([
    Promise.all(DJI_MIC2_OFFERS.map(([account,id])=>ctx.db.query("hygglo_products").withIndex("by_account_product",q=>q.eq("accountSlug",account).eq("productId",id)).first())),
    Promise.all(DJI_MIC2_OFFERS.map(([account,id])=>ctx.db.query("listing_resolution_override").withIndex("by_account_product",q=>q.eq("account_slug",account).eq("product_id",id)).take(2))),
  ]);
  if(rows.some(row=>!row))throw Error("A reviewed DJI Mic 2 offer disappeared");
  const products=rows.filter((row):row is NonNullable<typeof row>=>row!==null);
  const plan=djiMic2StockReview(items,products,overrideRows.flat());
  if(!dryRun){
    for(const row of plan.items)await patchStockInput(ctx,row.id,{...row.patch,updated_at:Date.now()});
    for(const row of plan.products)await patchProduct(ctx,row.id,row.patch,products.find(p=>p._id===row.id)!);
    for(const row of plan.inserts)await insertStockInput(ctx,"listing_resolution_override",{...row,source:"manual_audit",note:DJI_MIC2_REVIEW_SOURCE,updated_at:Date.now()});
    const count=plan.items.length+plan.products.length+plan.inserts.length;
    if(count)await ctx.db.insert("audit_log",{table_name:"items/hygglo_products/listing_resolution_override",actor:"catalogue-audit",op:"update",count,source_file:"seed/dji_mic2_stock_review.apply",note:DJI_MIC2_REVIEW_SOURCE,ts:Date.now()});
  }
  return {dryRun,reviewedOffers:products.length,itemWrites:plan.items.length,productWrites:plan.products.length,mappingInserts:plan.inserts.length,ownedQuantityChanged:false,rentalChanges:0,messagesSent:0,packingReviewRequired:true};
}});
