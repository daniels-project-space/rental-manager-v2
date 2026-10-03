import { verifiedItemSpec, type SpecRecord } from "./verified_item_spec";
export type LensRequirements = {focus_mode?: "autofocus"|"manual_focus"; wide_angle?: boolean; macro?: boolean; projection?: "fisheye"|"anamorphic"; excluded_projections?: Array<"fisheye"|"anamorphic">; coverage?: "full_frame"; focal_mm?: number; max_wide_focal_mm?: number; max_aperture_f?: number; max_aperture_t?: number};
export type LensCapabilities = LensRequirements & {focal_min_mm?: number; focal_max_mm?: number; model: string; source_url: string|null};
export type LensSpec = SpecRecord & {lens_capabilities?: Partial<LensCapabilities> & {verified_model?:string; verified_at?:number}};
/** Capability review must match the exact spec identity/source and remain current. */
export function verifiedLensCapabilities(spec: LensSpec | undefined, name: string): LensCapabilities|null {
 const verified=verifiedItemSpec(spec,name),cap=spec?.lens_capabilities;
 if(!verified||!cap||cap.verified_model!==verified.model||cap.source_url!==verified.source_url||!Number.isFinite(cap.verified_at)||cap.verified_at!<spec!.verified_at!)return null;
 for(const key of ["focal_min_mm","focal_max_mm","max_aperture_f","max_aperture_t"] as const)if(cap[key]!==undefined&&(!Number.isFinite(cap[key])||cap[key]!<=0))return null;
 if((cap.focal_min_mm===undefined)!==(cap.focal_max_mm===undefined)||cap.focal_min_mm!==undefined&&cap.focal_min_mm>cap.focal_max_mm!)return null;
 return {...cap,model:verified.model,source_url:verified.source_url};
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
/** Preserve explicit hard properties even if a caller omits structured fields.
 * Negated optional preferences are not converted into opposite requirements. */
function lensIntent(text:string) {
 const focusModes=new Set<string>(),projections=new Set<string>();
 const req:LensRequirements={};
 const optional=/\b(?:(?:don['’]?t|do not)\s+(?:need|require)|no need (?:for|to use))\s+(?:an?\s+)?(?:auto[- ]?focus|AF|manual[- ]focus|wide[- ]angle|macro|fisheye)\b/gi;
 let s=text.replace(optional,"");
 s=s.replace(/\b(?:non[- ]|no |not (?:an? )?|without |(?:don['’]?t|do not) want (?:an? )?)(fisheye|anamorphic)\b/gi,(_,projection:string)=>{req.excluded_projections=[...(req.excluded_projections??[]),projection.toLowerCase() as "fisheye"|"anamorphic"];return "";});
 s=s.replace(/\b(?:no |without |(?:don['’]?t|do not) want )(auto[- ]?focus|AF|manual[- ]focus)\b/gi,(_,focus:string)=>{req.focus_mode=/^(?:auto|AF$)/i.test(focus)?"manual_focus":"autofocus";focusModes.add(req.focus_mode);return "";});
 if(/\b(?:auto[- ]?focus|AF)\b/i.test(s)){req.focus_mode="autofocus";focusModes.add(req.focus_mode);}
 if(/\bmanual[- ]focus\b/i.test(s)){req.focus_mode="manual_focus";focusModes.add(req.focus_mode);}
 if(/\bwide[- ]angle\b/i.test(s))req.wide_angle=true;
 if(/\bmacro\b/i.test(s))req.macro=true;
 if(/\bfisheye\b/i.test(s)){req.projection="fisheye";projections.add(req.projection);}
 if(/\banamorphic\b/i.test(s)){req.projection="anamorphic";projections.add(req.projection);}
 return {requirements:req,conflict:focusModes.size>1||projections.size>1};
}
export function requestedLensRequirements(text:string):LensRequirements {return lensIntent(text).requirements;}
export function reconcileLensRequirements(explicit:LensRequirements|undefined, texts:string[]) {
 const req:LensRequirements={...explicit};let conflict=false;
 for(const text of texts){const intent=lensIntent(text),parsed=intent.requirements;conflict ||= intent.conflict;
  for(const [key,value] of Object.entries(parsed)){if(key==="excluded_projections"){req.excluded_projections=[...new Set([...(req.excluded_projections??[]),...(value as Array<"fisheye"|"anamorphic">)])];continue;}if(req[key as keyof LensRequirements]!==undefined&&req[key as keyof LensRequirements]!==value)conflict=true;Object.assign(req,{[key]:value});}
 }
 if(req.projection&&req.excluded_projections?.includes(req.projection))conflict=true;
 return {requirements:req,conflict};
}
