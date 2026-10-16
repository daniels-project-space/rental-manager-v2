import { internalMutation } from "../_generated/server";
import { patchProduct } from "../lib/product_context";
import { v } from "convex/values";
import { ownerAvailabilityReview, OWNER_AVAILABILITY_SOURCE } from "../lib/owner_availability_review";

export const apply = internalMutation({
  args:{dryRun:v.optional(v.boolean()),listingKeys:v.array(v.object({account:v.string(),productId:v.number()}))},
  handler:async(ctx,{dryRun=true,listingKeys})=>{
    // The read-only paginated audit supplies exact keys. The write transaction
    // does no catalogue scan and cannot touch arbitrary families or rentals.
    if(listingKeys.length>200||listingKeys.some(k=>!["dbcinema","diogo","leo"].includes(k.account)||!Number.isSafeInteger(k.productId)))throw Error("Invalid owner review scope");
    const items=await ctx.db.query("items").take(301);
    const keys=[...new Map([...listingKeys,{account:"leo",productId:1172943}].map(k=>[`${k.account}#${k.productId}`,k])).values()];
    const products=await Promise.all(keys.map(k=>ctx.db.query("hygglo_products").withIndex("by_account_product",q=>q.eq("accountSlug",k.account).eq("productId",k.productId)).first()));
    if(items.length===301||products.some(p=>!p))throw Error("Owner stock review snapshot is incomplete");
    const plan=ownerAvailabilityReview(items,products.filter((p):p is NonNullable<typeof p>=>p!==null));
    if(!dryRun){
      for(const row of plan.items)await ctx.db.patch(row.id,{...row.patch,updated_at:Date.now()});
      for(const row of plan.products){
        const at=Date.now();
        await patchProduct(ctx,row.id,{...row.patch,marketingOnlyUpdatedAt:at},products.find(p=>p?._id===row.id)!);
      }
    }
    return {dryRun,source:OWNER_AVAILABILITY_SOURCE,packingConfirmation:"16 October 2026: original GM, A7 V V90, paired Pyro S receiver",itemChanges:plan.items.map(p=>({name:p.name,fields:Object.keys(p.patch)})),listingChanges:plan.products.map(p=>({account:p.account,productId:p.productId,name:p.name})),rentalChanges:0,messagesSent:0};
  },
});
