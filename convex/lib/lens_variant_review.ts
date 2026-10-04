import { v } from "convex/values";
export const lensFactFields={
 focus_mode:v.optional(v.union(v.literal("autofocus"),v.literal("manual_focus"))),
 manual_focus_available:v.optional(v.boolean()),wide_angle:v.optional(v.boolean()),macro:v.optional(v.boolean()),
 projection:v.optional(v.union(v.literal("fisheye"),v.literal("anamorphic"),v.literal("rectilinear"))),coverage:v.optional(v.literal("full_frame")),
 focal_min_mm:v.optional(v.number()),focal_max_mm:v.optional(v.number()),max_aperture_f:v.optional(v.number()),max_aperture_t:v.optional(v.number()),
};
export const lensVariantReviewValidator=v.object({model:v.string(),source_urls:v.array(v.string()),verified_at:v.number(),review_notes:v.optional(v.string()),capabilities:v.object(lensFactFields)});
export type LensFacts={focus_mode?:"autofocus"|"manual_focus";manual_focus_available?:boolean;wide_angle?:boolean;macro?:boolean;projection?:"fisheye"|"anamorphic"|"rectilinear";coverage?:"full_frame";focal_min_mm?:number;focal_max_mm?:number;max_aperture_f?:number;max_aperture_t?:number};
export type LensVariantReview={model:string;source_urls:string[];verified_at:number;review_notes?:string;capabilities:LensFacts};
/** Only facts independently reviewed for every possible variant are usable.
 * A difference or missing review keeps that property unknown. */
export function sharedLensFacts(reviews:LensVariantReview[],specVerifiedAt:number,primarySource:string|null) {
 if(reviews.length<2||new Set(reviews.map(r=>r.model)).size!==reviews.length)return null;
 for(const review of reviews){
  if(!review.model.trim()||!Number.isFinite(review.verified_at)||review.verified_at<specVerifiedAt||!review.source_urls.length)return null;
  for(const url of review.source_urls){try{if(new URL(url).protocol!=="https:")return null;}catch{return null;}}
  for(const key of ["focal_min_mm","focal_max_mm","max_aperture_f","max_aperture_t"] as const){const value=review.capabilities[key];if(value!==undefined&&(!Number.isFinite(value)||value<=0))return null;}
  const cap=review.capabilities;
  if((cap.focal_min_mm===undefined)!==(cap.focal_max_mm===undefined)||cap.focal_min_mm!==undefined&&cap.focal_min_mm>cap.focal_max_mm!)return null;
 }
 if(!primarySource||!reviews.some(r=>r.source_urls.includes(primarySource)))return null;
 const common:LensFacts={};
 for(const key of Object.keys(lensFactFields) as Array<keyof LensFacts>){
  const value=reviews[0].capabilities[key];
  if(value!==undefined&&reviews.every(r=>r.capabilities[key]===value))Object.assign(common,{[key]:value});
 }
 return common;
}
