import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { sharedLensFacts, type LensVariantReview } from "./lib/lens_variant_review";
const families=[
 {name:"Sony GM 16-35mm f2.8",range:[16,35],models:["SEL1635GM","SEL1635GM2"],wide_angle:true},
 {name:"Sony GM 24-70mm f2.8",range:[24,70],models:["SEL2470GM","SEL2470GM2"]},
];
/** Shared owned-inventory facts only. Exact generation and generation-specific
 * dimensions, weight, motors and accessories remain unconfirmed. */
export const run=internalMutation({args:{apply:v.optional(v.boolean())},handler:async(ctx,{apply})=>{
 const changes=[];
 for(const family of families){
  const item=await ctx.db.query("items").withIndex("by_canonical_name",q=>q.eq("name_canonical",family.name)).unique();
  if(!item||item.kind!=="lens"||item.status!=="active"||item.is_marketing_only||item.qty<1||!/^E$|Sony E/i.test(item.lens_mount??""))throw new Error(`Owned E-mount family identity changed: ${family.name}`);
  const previous=await ctx.db.query("item_specs").withIndex("by_item",q=>q.eq("item_id",item._id)).unique();
  if(previous&&(previous.source==="owner-verified"||previous.source==="manufacturer-verified")&&!previous.lens_variant_reviews)throw new Error(`An exact-model review exists; preserve it: ${family.name}`);
  const now=Date.now();
  const reviews:LensVariantReview[]=family.models.map(model=>({model,verified_at:now,source_urls:[
   `https://www.sony.co.uk/electronics/support/lenses-e-mount-lenses/${model.toLowerCase()}/specifications`,
   model.endsWith("2")?`https://www.sony.co.uk/lenses/products/${model.toLowerCase()}`:`https://www.sony.co.uk/electronics/camera-lenses/${model.toLowerCase()}`,
  ],capabilities:{focus_mode:"autofocus",focal_min_mm:family.range[0],focal_max_mm:family.range[1],max_aperture_f:2.8,coverage:"full_frame",...(family.wide_angle?{wide_angle:true}:{})}}));
  const source_url=reviews[0].source_urls[0];
  if(!sharedLensFacts(reviews,now,source_url))throw new Error("Invalid variant review");
  const patch={item_id:item._id,item_name_canonical:family.name,source:"manufacturer-verified",source_url,verified_at:now,
   verified_model:`Sony FE ${family.range[0]}-${family.range[1]}mm F2.8 GM / GM II (generation unconfirmed)`,
   description:`Sony FE ${family.range[0]}-${family.range[1]}mm f/2.8 E-mount full-frame autofocus zoom. These capabilities are shared by GM and GM II. The owned generation is unconfirmed; do not claim GM II or generation-specific weight, dimensions, AF motors, performance or kit contents.`,
   specs_long:"",lens_variant_reviews:reviews};
  if(apply){if(previous)await ctx.db.patch(previous._id,{...patch,lens_capabilities:undefined});else await ctx.db.insert("item_specs",{...patch,created_at:now});}
  changes.push({name:family.name,item_id:item._id,previous,review:patch,applied:!!apply});
 }
 return {changes};
}});
