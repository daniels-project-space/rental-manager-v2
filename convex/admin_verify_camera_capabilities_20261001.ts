import {fullFrameDci4kMode,FULL_FRAME_RECORDING_SOURCE} from "./lib/blackmagic_recording_review";
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { verifiedCameraCapabilities } from "./lib/camera_requirements";
import { verifiedItemSpec } from "./lib/verified_item_spec";
import type { CameraCapabilities, RecordingMode } from "./lib/camera_requirements";
const FX3_ND_SOURCE_URL="https://www.sony.com.au/interchangeable-lens-cameras/products/ilme-fx3/ILME-FX3_BIG6_Home_screen_video_transcript";

// Exact owned models already reviewed; these fields are manufacturer facts,
// not quantities, rental inclusions or permissions. Missing ND stays unknown.
const profiles: Array<{ name: string; model: string; capabilities: CameraCapabilities }> = [
  { name: "Sony A7 II", model: "ILCE-7M2", capabilities: { role: "interchangeable_lens", sensor_format: "full_frame", native_mount: "E", internal_4k: false } },
  { name: "Sony A7 III", model: "ILCE-7M3", capabilities: { role: "interchangeable_lens", sensor_format: "full_frame", native_mount: "E", internal_4k: true } },
  { name: "Sony A7 V", model: "ILCE-7M5", capabilities: { role: "interchangeable_lens", sensor_format: "full_frame", native_mount: "E", internal_4k: true } },
  { name: "Sony FX3", model: "ILME-FX3", capabilities: { role: "interchangeable_lens", sensor_format: "full_frame", native_mount: "E", internal_4k: true, built_in_nd:false } },
  { name: "BMPCC 6K Pro", model: "Blackmagic Pocket Cinema Camera 6K Pro", capabilities: { role: "interchangeable_lens", sensor_format: "super35", native_mount: "EF", internal_4k: true, built_in_nd: true } },
  { name: "BMPCC 6K Full Frame", model: "Blackmagic Cinema Camera 6K", capabilities: { role: "interchangeable_lens", sensor_format: "full_frame", native_mount: "L", internal_4k: true } },
  { name: "GoPro 12 Hero", model: "HERO12 Black", capabilities: { role: "action", sensor_format: "small_sensor", internal_4k: true } },
  { name: "DJI Osmo Action Pro 5", model: "Osmo Action 5 Pro", capabilities: { role: "action", sensor_format: "small_sensor", internal_4k: true } },
];

const modeSources = {
  "Blackmagic Cinema Camera 6K": FULL_FRAME_RECORDING_SOURCE,
  "ILCE-7M5": "https://helpguide.sony.net/ilc/2540/v1/en/contents/0404M_angle_of_view.html",
  "ILME-FX3": "https://helpguide.sony.net/ilc/2210/v1/en/contents/TP1000882803.html",
};
// Reviewed exact-model Sony guides. No FX3A variant or numerical crop factor
// is substituted for the original FX3. This is a partial reviewed mode set;
// absent modes remain unknown, rather than being inferred from maximum FPS.
function reviewedModes(model: string, reviewedAt: number): RecordingMode[] | undefined {
  const proof = { verified_model: model, source_url: modeSources[model as keyof typeof modeSources], verified_at: reviewedAt };
  if (!proof.source_url) return undefined;
  if (model === "Blackmagic Cinema Camera 6K") return [fullFrameDci4kMode(reviewedAt)];
  if (model === "ILCE-7M5") return [
    { ...proof, resolution: "uhd_4k", nominal_fps: [24, 25, 30, 50, 60], capture_format: "full_frame", full_width: true, internal: true, conditions: ["APS-C/S35 Shooting Off (or Auto with full-frame lens). At 60p/50p, set 4K angle of view Priority On for full-width recording."] },
    { ...proof, resolution: "uhd_4k", nominal_fps: [100, 120], capture_format: "aps_c", full_width: false, internal: true, conditions: ["4K120p/100p requires APS-C/Super 35 capture with reduced angle of view; cannot supply full-frame/full-width 4K120."] },
  ];
  return [
    { ...proof, resolution: "uhd_4k", nominal_fps: [24, 25, 30, 50, 60], capture_format: "full_frame", full_width: true, internal: true, conditions: ["APS-C/S35 Shooting Off. Stabilization and attached lens may change the angle of view."] },
    { ...proof, resolution: "uhd_4k", nominal_fps: [100, 120], capture_format: "full_frame", full_width: false, internal: true, conditions: ["4K119.88p/100p uses a narrower angle of view than other 4K modes, as shown in Sony's exact FX3 guide. This is not APS-C/Super 35 mode, but is not completely uncropped/full width. Numerical crop factor is not reviewed here."] },
  ];
}

export const run = internalMutation({ args: {}, handler: async ctx => {
  const changes = [];
  for (const profile of profiles) {
    const item = await ctx.db.query("items").withIndex("by_canonical_name", q => q.eq("name_canonical", profile.name)).unique();
    if (!item || item.kind !== "camera") throw new Error(`Missing exact camera ${profile.name}`);
    const spec = await ctx.db.query("item_specs").withIndex("by_item", q => q.eq("item_id", item._id)).unique();
    if (!spec || spec.verified_model !== profile.model || !verifiedItemSpec(spec, profile.name)) throw new Error(`Review provenance changed for ${profile.name}`);
    const reviewedAt = Date.now();
    const modes = reviewedModes(profile.model, reviewedAt);
    const capabilities = { ...profile.capabilities, ...(modes ? { recording_modes: modes } : {}),
      ...(profile.model==="ILME-FX3"?{built_in_nd_review:{verified_model:profile.model,source_url:FX3_ND_SOURCE_URL,verified_at:reviewedAt}}:{}),
      verified_model: profile.model, source_url: spec.source_url, verified_at: reviewedAt };
    await ctx.db.patch(spec._id, { camera_capabilities: capabilities });
    changes.push({ item: profile.name, model: profile.model, source_url: spec.source_url, previous: spec.camera_capabilities ?? null, capabilities });
  }
  return { changes };
} });
/** A feature review must not overwrite independent sensor/mode reviews.
 * Sony's exact FX3 home-screen transcript explicitly distinguishes the ND
 * metadata menu from a physical built-in filter. */
export const reviewFx3Nd=internalMutation({args:{dry_run:v.optional(v.boolean())},handler:async(ctx,args)=>{
 const source_url=FX3_ND_SOURCE_URL;
 const item=await ctx.db.query("items").withIndex("by_canonical_name",q=>q.eq("name_canonical","Sony FX3")).unique();
 if(!item || item.kind!=="camera")throw new Error("Exact Sony FX3 inventory record is required");
 const spec=await ctx.db.query("item_specs").withIndex("by_item",q=>q.eq("item_id",item._id)).unique();
 if(!spec || spec.verified_model!=="ILME-FX3" || !verifiedCameraCapabilities(spec,item.name_canonical))throw new Error("FX3 review identity needs checking");
 const previous=spec.camera_capabilities!;
 if(previous.built_in_nd===false && previous.built_in_nd_review?.source_url===source_url && previous.built_in_nd_review.verified_model===spec.verified_model)
  return {changed:false,item:item.name_canonical,capabilities:previous};
 const capabilities={...previous,built_in_nd:false,built_in_nd_review:{verified_model:spec.verified_model,source_url,verified_at:Date.now()}};
 if(!args.dry_run)await ctx.db.patch(spec._id,{camera_capabilities:capabilities});
 return {changed:!args.dry_run,dry_run:args.dry_run??false,item:item.name_canonical,previous,capabilities};
}});

/** Extend only the reviewed recording mode, preserving sensor/ND and all
 * unrelated source reviews. No stock, kit, price or booking writes. */
export const reviewFullFrameDci4k=internalMutation({args:{dry_run:v.optional(v.boolean())},handler:async(ctx,args)=>{
 const item=await ctx.db.query("items").withIndex("by_canonical_name",q=>q.eq("name_canonical","BMPCC 6K Full Frame")).unique();
 if(!item||item.kind!=="camera")throw new Error("Exact Full Frame camera inventory record is required");
 const spec=await ctx.db.query("item_specs").withIndex("by_item",q=>q.eq("item_id",item._id)).unique();
 if(!spec||spec.verified_model!=="Blackmagic Cinema Camera 6K"||!verifiedCameraCapabilities(spec,item.name_canonical))throw new Error("Full Frame review identity needs checking");
 const previous=spec.camera_capabilities!,mode=fullFrameDci4kMode(Date.now());
 const same=(m:RecordingMode)=>JSON.stringify({...m,verified_at:0})===JSON.stringify({...mode,verified_at:0});
 if(previous.recording_modes?.some(m=>same(m)&&m.verified_at>=spec.verified_at!))return {changed:false,item:item.name_canonical,capabilities:previous};
 if(previous.recording_modes?.some(m=>m.resolution==="dci_4k"&&!same(m)))throw new Error("Existing DCI mode review needs reconciliation before replacement");
 const capabilities={...previous,recording_modes:[...(previous.recording_modes??[]).filter(m=>!same(m)),mode]};
 if(!args.dry_run)await ctx.db.patch(spec._id,{camera_capabilities:capabilities});
 return {changed:!args.dry_run,dry_run:args.dry_run??false,item:item.name_canonical,previous,capabilities};
}});
