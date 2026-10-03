import { normalizeMount } from "./item_name_match";
import { v, type Infer } from "convex/values";
export const lensRequirementsValidator = v.object({
 excluded_projections:v.optional(v.array(v.union(v.literal("fisheye"),v.literal("anamorphic")))),focus_mode:v.optional(v.union(v.literal("autofocus"),v.literal("manual_focus"))),
 wide_angle:v.optional(v.boolean()),macro:v.optional(v.boolean()),projection:v.optional(v.union(v.literal("fisheye"),v.literal("anamorphic"))),coverage:v.optional(v.literal("full_frame")),
 focal_mm:v.optional(v.number()),max_wide_focal_mm:v.optional(v.number()),max_aperture_f:v.optional(v.number()),max_aperture_t:v.optional(v.number()),
});
export const ownerCheckValidator=v.object({kind:v.literal("lens_recommendation"),source_call_id:v.string(),requirements:lensRequirementsValidator,
 candidate_item_ids:v.array(v.id("items")),lens_mount:v.union(v.string(),v.null()),start_date:v.union(v.string(),v.null()),end_date:v.union(v.string(),v.null()),quantity:v.number()});
export type OwnerCheck=Infer<typeof ownerCheckValidator>;
/** Actual Native tool receipts, never free-form model promises. */
export function nativeOwnerChecks(receipts:Array<{tool:string;call_id:string;result:Record<string,unknown>}>) {
 return receipts.filter(r=>r.tool==="find_owned_alternatives"&&r.call_id&&r.result.owner_check)
  .map(r=>({...r.result.owner_check as Omit<OwnerCheck,"source_call_id">,source_call_id:r.call_id}));
}
export function ownerCheckKey(thread:string,message:string,check:OwnerCheck) {
 return JSON.stringify([thread,message,check.kind,normalizeMount(check.lens_mount),check.start_date,check.end_date,check.quantity,
  Object.entries(check.requirements).filter(([,v])=>v!==undefined).map(([k,v])=>[k,Array.isArray(v)?[...v].sort():v] as [string,unknown]).sort(([a],[b])=>a.localeCompare(b))]);
}
