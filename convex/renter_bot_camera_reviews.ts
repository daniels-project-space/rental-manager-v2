import {v} from "convex/values";
import {query,mutation,requireOwner} from "./owner_functions";
import {specificationReviewTarget} from "./renter_bot_owner_checks";
import {ownerCheckRequestMessageId} from "./lib/owner_check_request";
import {assessCameraRequirements,cameraRecordingReviews,verifiedCameraCapabilities,RECORDING_MODE_RESOLUTIONS} from "./lib/camera_requirements";
import {cameraIdentityReviewedAt} from "./lib/camera_identity_review";
import type {Doc} from "./_generated/dataModel";
const targetArgs={task_id:v.id("renter_bot_owner_checks"),item_id:v.id("items")};
const format=v.union(v.literal("full_frame"),v.literal("super35"),v.literal("aps_c"),v.literal("small_sensor"));
export const getReview=query({args:targetArgs,handler:async(ctx,a)=>{
 try{const {task,item,spec,revision}=await specificationReviewTarget(ctx,a.task_id,a.item_id,"camera_recommendation");
  const profile=verifiedCameraCapabilities(spec,item.name_canonical);
  return {available:true as const,task_id:task._id,item_id:item._id,name:item.name_canonical,request_message_id:ownerCheckRequestMessageId(task),revision,
   model:profile?spec!.verified_model!:null,source_url:profile?(spec!.source_url??null):null,profile,recording_reviews:profile?cameraRecordingReviews(spec!):[]};
 }catch(error){return {available:false as const,message:error instanceof Error?error.message:"The camera review is unavailable"};}
}});
function referenceUrl(value:string){const url=value.trim();try{if(url.length>2000||new URL(url).protocol!=="https:")throw new Error();}catch{throw new Error("Add an HTTPS reference for the properties you reviewed");}return url;}
export const saveReview=mutation({args:{...targetArgs,expected_request_message_id:v.string(),expected_revision:v.string(),confirmed_model:v.boolean(),dry_run:v.optional(v.boolean()),change:v.union(
 v.object({kind:v.literal("profile"),model:v.string(),source_url:v.string(),role:v.union(v.literal("action"),v.literal("interchangeable_lens")),sensor_format:format,native_mount:v.optional(v.string()),internal_4k:v.boolean(),built_in_nd:v.optional(v.boolean())}),
 v.object({kind:v.literal("recording_mode"),mode_index:v.optional(v.number()),source_url:v.string(),resolution:v.union(...RECORDING_MODE_RESOLUTIONS.map(r=>v.literal(r))),nominal_fps:v.array(v.number()),capture_format:v.optional(format),full_width:v.boolean(),internal:v.boolean(),conditions:v.array(v.string())})
 )},handler:async(ctx,a)=>{
 await requireOwner(ctx,true);
 const {task,item,spec,revision}=await specificationReviewTarget(ctx,a.task_id,a.item_id,"camera_recommendation");
 if(revision!==a.expected_revision||ownerCheckRequestMessageId(task)!==a.expected_request_message_id)throw new Error("The check or specification changed. Reopen the review before saving");
 if(!a.confirmed_model)throw new Error("Confirm the physical camera model and every property entered");
 const c=a.change,url=referenceUrl(c.source_url),now=Date.now(),previous=verifiedCameraCapabilities(spec,item.name_canonical);
 let patch:Partial<Doc<"item_specs">>&Pick<Doc<"item_specs">,"description"|"source"|"item_name_canonical">;
 let mountChange:{lens_mount:string|undefined}|undefined;
 if(c.kind==="profile"){
  const model=c.model.trim(),mount=c.native_mount?.trim()||undefined;
  if(model.length<3||model.length>200||mount&&mount.length>80)throw new Error("Check the exact camera model and native mount");
  const sameIdentity=!!previous&&spec!.verified_model===model;
  const capability={role:c.role,sensor_format:c.sensor_format,native_mount:mount,internal_4k:c.internal_4k,built_in_nd:c.built_in_nd,
   built_in_nd_review:c.built_in_nd!==undefined?{verified_model:model,source_url:url,verified_at:now}:undefined,
   verified_model:model,source_url:url,verified_at:now,identity_review:{verified_model:model,verified_at:sameIdentity?cameraIdentityReviewedAt(spec!):now},
   recording_modes:sameIdentity?cameraRecordingReviews(spec!):undefined};
  patch={item_name_canonical:item.name_canonical,description:`Owner-reviewed camera: ${model}. ${c.role.replaceAll("_"," ")}; ${c.sensor_format.replaceAll("_"," ")} sensor; internal 4K: ${c.internal_4k}.`+(mount?` Native mount: ${mount}.`:"")+(c.built_in_nd!==undefined?` Built-in ND: ${c.built_in_nd}.`:""),
   specs_long:undefined,source:"owner-verified",source_url:url,verified_model:model,verified_at:now,camera_capabilities:capability};
  mountChange={lens_mount:mount};
 }else{
  if(!spec||!previous)throw new Error("Review the exact camera model and base profile before adding a recording mode");
  if(!c.nominal_fps.length||c.nominal_fps.length>32||c.nominal_fps.some(f=>!Number.isFinite(f)||f<=0))throw new Error("Enter positive nominal frame rates from the reference");
  if(c.conditions.length>12||c.conditions.some(s=>s.trim().length>600))throw new Error("Keep recording conditions to at most 12 brief notes");
  if(c.internal&&!previous.internal_4k)throw new Error("The reviewed camera profile does not support internal 4K");
  const modes=[...cameraRecordingReviews(spec)];
  if(c.mode_index!==undefined&&(!Number.isInteger(c.mode_index)||c.mode_index<0||c.mode_index>=modes.length))throw new Error("That recording review no longer exists");
  if(c.capture_format&&assessCameraRequirements(previous,{recording:{resolution:c.resolution,capture_format:c.capture_format}}).mismatched.includes("capture_format"))throw new Error("The capture area exceeds the reviewed physical sensor");
  const mode={resolution:c.resolution,nominal_fps:[...new Set(c.nominal_fps)].sort((x,y)=>x-y),capture_format:c.capture_format,full_width:c.full_width,internal:c.internal,
   conditions:c.conditions.map(s=>s.trim()).filter(Boolean),verified_model:spec.verified_model!,source_url:url,verified_at:now};
  if(c.mode_index===undefined){if(modes.length>=24)throw new Error("Review or replace an existing mode before adding more");modes.push(mode);}else modes[c.mode_index]=mode;
  patch={description:spec.description,source:spec.source,item_name_canonical:item.name_canonical,camera_capabilities:{...spec.camera_capabilities!,recording_modes:modes}};
 }
 const candidate={...spec,...patch},verified=verifiedCameraCapabilities(candidate,item.name_canonical);
 if(!verified)throw new Error("The source and camera identity do not establish a reviewed profile");
 const assessment=assessCameraRequirements(verified,task.check.kind==="camera_recommendation"?task.check.requirements:{},task.check.kind==="camera_recommendation"?task.check.lens_mount:null);
 if(a.dry_run)return {ok:true,preview:true,verified,assessment};
 if(spec)await ctx.db.patch(spec._id,patch);else await ctx.db.insert("item_specs",{...patch,item_id:item._id,created_at:now});
 if(mountChange)await ctx.db.patch(item._id,{...mountChange,updated_at:now});
 const identity=await ctx.auth.getUserIdentity();await ctx.db.insert("audit_log",{table_name:"item_specs",actor:identity?.subject??"owner-service",op:spec?"update":"insert",count:1,source_file:"renter_bot_camera_reviews.saveReview",
  note:JSON.stringify({item_id:item._id,task_id:task._id,change:c.kind,before:spec??null,after:patch,previous_mount:item.lens_mount??null,mount_change:mountChange??null}),ts:now});
 const settings=await ctx.db.query("settings").first();if(settings)await ctx.db.patch(settings._id,{draft_epoch:(settings.draft_epoch??0)+1});
 return {ok:true,preview:false,verified,assessment};
}});
