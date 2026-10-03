import { internalMutation } from "./_generated/server";
import { verifiedItemSpec } from "./lib/verified_item_spec";
import { REVIEWED_REMUS_SPECS } from "./lib/reviewed_remus_specs";
/** Partial exact-model profiles only: absent properties remain unknown. */
const profiles = [
 {name:"Sony FE 90mm f2.8 Macro G OSS",model:"SEL90M28G",capabilities:{focal_min_mm:90,focal_max_mm:90,max_aperture_f:2.8,macro:true,focus_mode:"autofocus" as const,manual_focus_available:true,wide_angle:false,coverage:"full_frame" as const}},
 {name:"TTArtisan 11mm f2.8 Fisheye (Sony E)",model:"TTArtisan 11mm F2.8 Fisheye (Sony E)",capabilities:{focal_min_mm:11,focal_max_mm:11,max_aperture_f:2.8,focus_mode:"manual_focus" as const,projection:"fisheye" as const,coverage:"full_frame" as const}},
 ...REVIEWED_REMUS_SPECS.map(f=>({name:f.name,model:f.model,capabilities:{focal_min_mm:Number(/(\d+)mm/.exec(f.model)![1]),focal_max_mm:Number(/(\d+)mm/.exec(f.model)![1]),max_aperture_t:Number(f.aperture.slice(1)),projection:"anamorphic" as const,coverage:"full_frame" as const}})),
];
export const run = internalMutation({args:{},handler:async ctx=>{
 const changes=[];
 for(const profile of profiles){
  const item=await ctx.db.query("items").withIndex("by_canonical_name",q=>q.eq("name_canonical",profile.name)).unique();
  if(!item||item.kind!=="lens"||item.status!=="active"||item.is_marketing_only)throw new Error(`Exact owned lens missing: ${profile.name}`);
  const spec=await ctx.db.query("item_specs").withIndex("by_item",q=>q.eq("item_id",item._id)).unique();
  if(!spec||!verifiedItemSpec(spec,profile.name)||spec.verified_model!==profile.model||!spec.source_url)throw new Error(`Lens review changed: ${profile.name}`);
  const reviewedAt=Date.now();
  const sony=profile.model==="SEL90M28G";
  // Exact AF/manual switch and AF controls reviewed on Sony's model page.
  const source=sony?"https://www.sony.co.uk/electronics/camera-lenses/sel90m28g/specifications":spec.source_url;
  const capabilities={...profile.capabilities,verified_model:profile.model,source_url:source,verified_at:reviewedAt};
  await ctx.db.patch(spec._id,{lens_capabilities:capabilities,...(sony?{source_url:source,verified_at:reviewedAt,description:spec.description.replace(/ Supports autofocus and manual-focus selection\.$/,"")+" Supports autofocus and manual-focus selection."}:{})});changes.push({name:profile.name,capabilities});
 }
 return {changes};
}});
