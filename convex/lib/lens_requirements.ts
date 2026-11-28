import { sharedLensFacts, type LensVariantReview } from "./lens_variant_review";
import { verifiedItemSpec, type SpecRecord } from "./verified_item_spec";
import { reviewedLensMount } from "./reviewed_lens_mounts";
import { reviewedLensCapabilities } from "./reviewed_lens_capabilities";
export type LensRequirements = {focus_mode?: "autofocus"|"manual_focus"; wide_angle?: boolean; macro?: boolean; projection?: "fisheye"|"anamorphic"|"rectilinear"; excluded_projections?: Array<"fisheye"|"anamorphic"|"rectilinear">; coverage?: "full_frame"; focal_mm?: number; max_wide_focal_mm?: number; max_aperture_f?: number; max_aperture_t?: number};
export type LensCapabilities = LensRequirements & {manual_focus_available?: boolean; focal_min_mm?: number; focal_max_mm?: number; model: string; source_url: string|null; model_scope?:"shared_variants"; reviewed_models?:Array<{model:string;source_urls:string[]}>};
export type LensSpec = SpecRecord & {lens_variant_reviews?:LensVariantReview[];lens_capabilities?: Partial<LensCapabilities> & {verified_model?:string; verified_at?:number}};
function mergeOwnerReviewedCapabilities(cap: LensCapabilities, name: string): LensCapabilities|null {
 const reviewed=reviewedLensCapabilities(name);
 if(!reviewed)return cap;
 if(cap.focus_mode!==undefined&&cap.focus_mode!==reviewed.focus_mode)return null;
 return {...cap,focus_mode:reviewed.focus_mode};
}
/** Reviews must match the inventory identity and remain current. Shared variant
 * reviews expose only their intersection, never an asserted exact generation. */
export function verifiedLensCapabilities(spec: LensSpec | undefined, name: string): LensCapabilities|null {
 const verified=verifiedItemSpec(spec,name),cap=spec?.lens_capabilities,reviewed=reviewedLensMount(name);
 // This exact physical inventory identity has a separate manufacturer-backed
 // review. Let that narrow review supply only its proven fields when the broad
 // item-spec record is absent; never infer unreviewed autofocus or lens facts.
 if(!verified){
  if(!reviewed || spec?.verified_model&&spec.verified_model!==reviewed.model)return null;
  return mergeOwnerReviewedCapabilities({model:reviewed.model,source_url:reviewed.source_url,...(reviewed.coverage?{coverage:reviewed.coverage}:{})},name);
 }
 if(verified&&spec?.lens_variant_reviews!==undefined){
  if(spec.source!=="manufacturer-verified")return null;
  const shared=sharedLensFacts(spec.lens_variant_reviews,spec.verified_at!,verified.source_url);
  return shared?mergeOwnerReviewedCapabilities({...shared,model:verified.model,source_url:verified.source_url,model_scope:"shared_variants",reviewed_models:spec.lens_variant_reviews.map(r=>({model:r.model,source_urls:r.source_urls}))},name):null;
 }
 if(reviewed&&verified.model!==reviewed.model)return null;
 if(!cap){
  if(!reviewed)return null;
  return mergeOwnerReviewedCapabilities({model:verified.model,source_url:verified.source_url,...(reviewed.coverage?{coverage:reviewed.coverage}:{})},name);
 }
 if(cap.verified_model!==verified.model||cap.source_url!==verified.source_url||!Number.isFinite(cap.verified_at)||cap.verified_at!<spec!.verified_at!)return null;
 for(const key of ["focal_min_mm","focal_max_mm","max_aperture_f","max_aperture_t"] as const)if(cap[key]!==undefined&&(!Number.isFinite(cap[key])||cap[key]!<=0))return null;
 if((cap.focal_min_mm===undefined)!==(cap.focal_max_mm===undefined)||cap.focal_min_mm!==undefined&&cap.focal_min_mm>cap.focal_max_mm!)return null;
 if(reviewed?.coverage&&cap.coverage&&reviewed.coverage!==cap.coverage)return null;
 return mergeOwnerReviewedCapabilities({...cap,...(reviewed?.coverage&&!cap.coverage?{coverage:reviewed.coverage}:{}),model:verified.model,source_url:verified.source_url},name);
}
export function hasLensRequirements(req:LensRequirements){return Object.values(req).some(v=>v!==undefined&&(!Array.isArray(v)||v.length>0));}
export function meetsLensRequirements(cap:LensCapabilities|null,req:LensRequirements) {
 if(!hasLensRequirements(req))return true;if(!cap)return false;
 for(const key of ["focus_mode","wide_angle","macro","projection","coverage"] as const)if(req[key]!==undefined&&cap[key]!==req[key])return false;
 if(req.excluded_projections?.length&&(!cap.projection||req.excluded_projections.includes(cap.projection)))return false;
 if(req.focal_mm!==undefined&&(!Number.isFinite(req.focal_mm)||req.focal_mm<=0||cap.focal_min_mm===undefined||cap.focal_max_mm===undefined||req.focal_mm<cap.focal_min_mm||req.focal_mm>cap.focal_max_mm))return false;
 for(const [key,value] of [["max_wide_focal_mm",cap.focal_min_mm],["max_aperture_f",cap.max_aperture_f],["max_aperture_t",cap.max_aperture_t]] as const)if(req[key]!==undefined&&(!Number.isFinite(req[key])||req[key]!<=0||value===undefined||value>req[key]!))return false;
 return true;
}
/** Assess each structured desired-item requirement independently. Missing
 * reviewed evidence is distinct from a reviewed property that fails it. */
export function assessLensRequirements(cap: LensCapabilities | null, req: LensRequirements) {
 const unknown: string[] = [], mismatched: string[] = [];
 for (const [key,value] of Object.entries(req)) {
  if(value===undefined||(Array.isArray(value)&&!value.length))continue;
  const known = key==="focal_mm" ? cap?.focal_min_mm!==undefined&&cap?.focal_max_mm!==undefined
   : key==="max_wide_focal_mm" ? cap?.focal_min_mm!==undefined
   : key==="excluded_projections" ? cap?.projection!==undefined
   : cap?.[key as keyof LensCapabilities]!==undefined;
  if(!known)unknown.push(key);
  else if(!meetsLensRequirements(cap,{[key]:value}))mismatched.push(key);
 }
 return {status:mismatched.length ? "mismatch" as const : unknown.length ? "unknown" as const : "match" as const,unknown,mismatched};
}
