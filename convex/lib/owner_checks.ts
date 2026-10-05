import {cameraRequirementsValidator} from "./camera_requirement_validator";
import { normalizeMount } from "./item_name_match";
import { v, type Infer } from "convex/values";
export const lensRequirementsValidator = v.object({
 excluded_projections:v.optional(v.array(v.union(v.literal("fisheye"),v.literal("anamorphic"),v.literal("rectilinear")))),focus_mode:v.optional(v.union(v.literal("autofocus"),v.literal("manual_focus"))),
 wide_angle:v.optional(v.boolean()),macro:v.optional(v.boolean()),projection:v.optional(v.union(v.literal("fisheye"),v.literal("anamorphic"),v.literal("rectilinear"))),coverage:v.optional(v.literal("full_frame")),
 focal_mm:v.optional(v.number()),max_wide_focal_mm:v.optional(v.number()),max_aperture_f:v.optional(v.number()),max_aperture_t:v.optional(v.number()),
});
const checkDates={start_date:v.union(v.string(),v.null()),end_date:v.union(v.string(),v.null()),quantity:v.number()};
export const ownerCheckValidator=v.union(v.object({kind:v.literal("lens_recommendation"),source_call_id:v.string(),requirements:lensRequirementsValidator,
 candidate_item_ids:v.array(v.id("items")),lens_mount:v.union(v.string(),v.null()),...checkDates}),
 v.object({kind:v.literal("camera_recommendation"),source_call_id:v.string(),requirements:cameraRequirementsValidator,
 candidate_item_ids:v.array(v.id("items")),lens_mount:v.union(v.string(),v.null()),...checkDates}),
 v.object({kind:v.literal("listing_mapping"),source_call_id:v.string(),product_id:v.number(),...checkDates}),
 v.object({kind:v.literal("kit_recommendation"),source_call_id:v.string(),candidate_product_ids:v.array(v.number()),...checkDates}));
export type OwnerCheck=Infer<typeof ownerCheckValidator>;
/** Actual Native tool receipts, never free-form model promises. */
export function nativeOwnerChecks(receipts:Array<{tool:string;call_id:string;result:Record<string,unknown>}>) {
 return receipts.flatMap(r=>{
  if(!r.call_id)return [];
  if(r.tool==="find_owned_alternatives"&&r.result.owner_check)
   return [{...r.result.owner_check as Exclude<OwnerCheck,{kind:"listing_mapping"}>,source_call_id:r.call_id}];
  if(r.tool==="get_listing_context"&&Array.isArray(r.result.owner_checks))
   return r.result.owner_checks.filter(c=>c?.kind==="listing_mapping").map(c=>({...c,source_call_id:r.call_id})) as OwnerCheck[];
  return [];
 });
}
function requirementScope(value:unknown):unknown {
 if(Array.isArray(value))return value.map(requirementScope).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 if(value&&typeof value==="object")return Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,requirementScope(v)]);
 return value;
}
function ownerCheckScope(check:OwnerCheck) {
 if(check.kind==="listing_mapping")return [check.kind,check.product_id,check.start_date,check.end_date,check.quantity];
 if(check.kind==="kit_recommendation")return [check.kind,check.start_date,check.end_date,check.quantity];
 return [check.kind,normalizeMount(check.lens_mount),check.start_date,check.end_date,check.quantity,
  requirementScope(check.requirements)];
}
/** A known non-rentable listing is a denial, not an unresolved owner task. */
export function listingMappingOwnerCheck(physical:{product_id:number;listing_name:string|null;complete:boolean;contents_review_required?:boolean;owned:boolean|null;valid_quantity:boolean}|null,
 dates:{start_date:string|null;end_date:string|null;quantity:number}) {
 if(!physical?.listing_name||physical.complete&&!physical.contents_review_required||physical.owned===false||!physical.valid_quantity)return null;
 return {kind:"listing_mapping" as const,product_id:physical.product_id,...dates};
}
export function ownerCheckScopeKey(check:OwnerCheck) {return JSON.stringify(ownerCheckScope(check));}
export function ownerCheckKey(thread:string,message:string,check:OwnerCheck,contextKey?:string) {
 return JSON.stringify([thread,message,...(contextKey===undefined?[]:[contextKey]),...ownerCheckScope(check)]);
}
