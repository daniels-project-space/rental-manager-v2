import {cameraRequirementsValidator} from "./camera_requirement_validator";
import { normalizeMount } from "./item_name_match";
import type {StockQuoteEvidence} from "./renter_draft_evidence";
import {renterItemNames} from "./renter_item_names";
import { v, type Infer } from "convex/values";
export const lensRequirementsValidator = v.object({
 excluded_projections:v.optional(v.array(v.union(v.literal("fisheye"),v.literal("anamorphic"),v.literal("rectilinear")))),focus_mode:v.optional(v.union(v.literal("autofocus"),v.literal("manual_focus"))),
 wide_angle:v.optional(v.boolean()),macro:v.optional(v.boolean()),projection:v.optional(v.union(v.literal("fisheye"),v.literal("anamorphic"),v.literal("rectilinear"))),coverage:v.optional(v.literal("full_frame")),
 focal_mm:v.optional(v.number()),max_wide_focal_mm:v.optional(v.number()),max_aperture_f:v.optional(v.number()),max_aperture_t:v.optional(v.number()),
});
const checkDates={start_date:v.union(v.string(),v.null()),end_date:v.union(v.string(),v.null()),quantity:v.number(),purpose:v.optional(v.union(v.literal("request"),v.literal("inventory")))};
export const ownerCheckValidator=v.union(v.object({kind:v.literal("lens_recommendation"),source_call_id:v.string(),requirements:lensRequirementsValidator,
 candidate_item_ids:v.array(v.id("items")),lens_mount:v.union(v.string(),v.null()),...checkDates}),
 v.object({kind:v.literal("camera_recommendation"),source_call_id:v.string(),requirements:cameraRequirementsValidator,
 candidate_item_ids:v.array(v.id("items")),lens_mount:v.union(v.string(),v.null()),...checkDates}),
 v.object({kind:v.literal("listing_mapping"),source_call_id:v.string(),product_id:v.number(),...checkDates}),
 v.object({kind:v.literal("kit_recommendation"),source_call_id:v.string(),candidate_product_ids:v.array(v.number()),...checkDates}));
export type OwnerCheck=Infer<typeof ownerCheckValidator>;
export function ownerCheckBlocksRequest(check:OwnerCheck) {return check.kind!=="kit_recommendation"||check.purpose!=="inventory";}
function discussesKit(text:string,name:string) {
 return renterItemNames(name).some(alias=>{
  const parts=alias.match(/[a-z0-9]+/gi);
  if(!parts?.length)return false;
  // An exact model can be discussed without its brand. Retain the whole
  // model suffix so FX3 never matches FX30 or A7 V matches A7 VI.
  const forms=[parts,...parts.flatMap((part,index)=>index>0&&/\d/.test(part)?[parts.slice(index)]:[])];
  return forms.some(form=>new RegExp(`(?:^|[^a-z0-9])${form.join("[^a-z0-9]*")}(?=$|[^a-z0-9])`,"i").test(text));
 });
}
/** A selected Native offer can make another search candidate's review
 * inventory work. It cannot settle the candidate's unknown kit facts. */
function unchosenKitReview(check:OwnerCheck,result:Record<string,unknown>,selection:{quotes:StockQuoteEvidence[];discussion:string}) {
 if(check.kind!=="kit_recommendation"||!Array.isArray(result.alternatives)||check.start_date===null||check.end_date===null)return false;
 const rows=result.alternatives as Array<{product_id?:number;name?:string;spec_verification?:{model?:string}}>;
 if(selection.quotes.some(quote=>quote.listing_quote?.lines.some(line=>check.candidate_product_ids.includes(line.product_id))))return false;
 if(rows.some(row=>check.candidate_product_ids.includes(row.product_id!)&&[row.name,row.spec_verification?.model].some(name=>typeof name==="string"&&discussesKit(selection.discussion,name))))return false;
 return selection.quotes.some(quote=>quote.start_date===check.start_date&&quote.end_date===check.end_date&&
  quote.listing_quote?.lines.some(line=>line.quantity===check.quantity&&!check.candidate_product_ids.includes(line.product_id)&&rows.some(row=>row.product_id===line.product_id)));
}
/** Actual Native tool receipts and rendered selections, never model task labels. */
export function nativeOwnerChecks(receipts:Array<{tool:string;call_id:string;result:Record<string,unknown>}>,selection={quotes:[] as StockQuoteEvidence[],discussion:""}) {
 return receipts.flatMap(r=>{
  if(!r.call_id)return [];
  if(r.tool==="find_owned_alternatives"&&r.result.owner_check) {
   const check={...r.result.owner_check as Exclude<OwnerCheck,{kind:"listing_mapping"}>,source_call_id:r.call_id};
   return [unchosenKitReview(check,r.result,selection)?{...check,purpose:"inventory" as const}:check];
  }
  if(r.tool==="get_listing_context"&&Array.isArray(r.result.owner_checks))
   return r.result.owner_checks.filter(c=>c?.kind==="listing_mapping").map(c=>({...c,source_call_id:r.call_id})) as OwnerCheck[];
  if(r.tool==="check_basket_availability"&&Array.isArray(r.result.owner_checks))
   return r.result.owner_checks.filter(c=>c?.kind==="lens_recommendation"||c?.kind==="camera_recommendation").map(c=>({...c,source_call_id:r.call_id})) as OwnerCheck[];
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
