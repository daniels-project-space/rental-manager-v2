import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { patchStockInput } from "../lib/stock_input_writes";
import { mixedMicrophoneStockReview } from "../lib/mixed_microphone_stock_review";

export const apply=internalMutation({args:{dryRun:v.optional(v.boolean())},handler:async(ctx,{dryRun=true})=>{
  const items=await ctx.db.query("items").take(151);
  if(items.length===151)throw Error("Review master inventory audit bound");
  const [product,rows]=await Promise.all([
    ctx.db.query("hygglo_products").withIndex("by_account_product",q=>q.eq("accountSlug","dbcinema").eq("productId",1027212)).first(),
    ctx.db.query("listing_resolution_override").withIndex("by_account_product",q=>q.eq("account_slug","dbcinema").eq("product_id",1027212)).take(2),
  ]);
  if(!product||rows.length!==1)throw Error("Mixed offer or mapping changed");
  const plan=mixedMicrophoneStockReview(items,product,rows[0]);
  if(!dryRun){
    if(plan.item)await patchStockInput(ctx,plan.item.id,{listing_stock_rules:plan.item.listing_stock_rules,updated_at:Date.now()});
    if(plan.override)await patchStockInput(ctx,plan.override.id,{components:plan.override.components,source:"manual_audit",note:"Reviewed seller title includes two Rode Wireless Pro systems; DJI transmitter/receiver quantity still needs review.",updated_at:Date.now()});
    const count=Number(!!plan.item)+Number(!!plan.override);
    if(count)await ctx.db.insert("audit_log",{table_name:"items/listing_resolution_override",actor:"catalogue-audit",op:"update",count,source_file:"seed/mixed_microphone_stock_review.apply",note:"Mixed microphone kit: retain proven Rode stock, do not assert unresolved DJI quantity",ts:Date.now()});
  }
  return {dryRun,itemWrites:Number(!!plan.item),mappingWrites:Number(!!plan.override),ownedQuantityChanged:false,rentalChanges:0,messagesSent:0,requiresStockReview:true};
}});
