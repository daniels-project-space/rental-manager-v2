import {internalMutation} from "../_generated/server";
import {v} from "convex/values";
import {stockedCatalogueReview,STOCKED_CATALOGUE_KEYS,STOCKED_CATALOGUE_SOURCE} from "../lib/stocked_catalogue_review";
import {patchProduct} from "../lib/product_context";

export const apply=internalMutation({args:{dryRun:v.optional(v.boolean())},handler:async(ctx,{dryRun=true})=>{
  // One explicit maintenance audit: the inventory is capped at 150 records
  // (108 at qualification). All offering reads use exact indexed keys.
  const items=await ctx.db.query("items").take(151);if(items.length===151)throw Error("Review the inventory audit bound");
  const products=await Promise.all(STOCKED_CATALOGUE_KEYS.map(([account,id])=>ctx.db.query("hygglo_products").withIndex("by_account_product",q=>q.eq("accountSlug",account).eq("productId",id)).first()));
  if(products.some(p=>!p))throw Error("A reviewed listing disappeared; reacquire its identity");
  const plan=stockedCatalogueReview(items,products.filter((p):p is NonNullable<typeof p>=>p!==null));
  if(!dryRun){
    for(const row of plan.items)await ctx.db.patch(row.id,{...row.patch,updated_at:Date.now()});
    for(const row of plan.products)await patchProduct(ctx,row.id,row.patch,products.find(p=>p?._id===row.id)!);
  }
  return {dryRun,source:STOCKED_CATALOGUE_SOURCE,itemChanges:plan.items.map(row=>({name:row.name,fields:Object.keys(row.patch)})),reviewedProducts:plan.reviewedProducts,productWrites:plan.products.length,marketingListingWrites:0,rentalChanges:0,messagesSent:0};
}});
