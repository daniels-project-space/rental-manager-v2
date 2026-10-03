import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { resolveBundleMapping } from "./lib/bundle_mapping";
/** Reviewed internal inventory repair only. Re-read and validate the live
 * description, ownership and original mapping together in one transaction. */
export const run=internalMutation({args:{apply:v.optional(v.boolean())},handler:async(ctx,a)=>{
 const account_slug="leo",product_id=1172744;
 const listing=await ctx.db.query("online_listings").withIndex("by_account_product",q=>q.eq("account_slug",account_slug).eq("product_id",product_id)).unique();
 const mapping=await ctx.db.query("listing_resolution_override").withIndex("by_account_product",q=>q.eq("account_slug",account_slug).eq("product_id",product_id)).unique();
 const items=await ctx.db.query("items").collect();
 const exact=(name:string,kind:string)=>{
  const matches=items.filter(i=>i.name_canonical===name);
  if(matches.length!==1||matches[0].kind!==kind||matches[0].status!=="active"||matches[0].is_marketing_only||matches[0].qty<1)throw new Error(`Owned physical identity changed: ${name}`);
  return matches[0];
 };
 const lens=exact("Sony GM 16-35mm f2.8","lens"),filter=exact("ND filter","accessory");
 if(!listing||!mapping)throw new Error("Reviewed listing or mapping missing");
 const declared=resolveBundleMapping(listing.description??"",items);
 if(!declared.explicit||!declared.structured||declared.unmatched.length||declared.components.length!==2||!declared.components.some(c=>c.item_id===lens._id&&c.qty===1)||!declared.components.some(c=>c.item_id===filter._id&&c.qty===1))throw new Error("Live contents changed; review required");
 const before=mapping.components;
 const correct=before.length===2&&before.some(c=>c.item_id===lens._id&&c.qty===1)&&before.some(c=>c.item_id===filter._id&&c.qty===1);
 if(!correct&&(before.length!==1||before[0].item_id!==lens._id||before[0].qty!==1))throw new Error("Original mapping changed; preserve owner work");
 const after=[{item_id:lens._id,qty:1},{item_id:filter._id,qty:1}];
 if(a.apply&&!correct)await ctx.db.patch(mapping._id,{components:after,source:"reviewed-explicit-contents-2026-10-03",note:(mapping.note??"")+"; reconciled explicit included ND filter against owned inventory",updated_at:Date.now()});
 return {account_slug,product_id,mapping_id:mapping._id,before,after,applied:!!a.apply&&!correct,already_correct:correct};
}});
