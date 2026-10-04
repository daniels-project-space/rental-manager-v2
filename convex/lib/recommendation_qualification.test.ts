import {describe,it,expect} from "vitest";
import {qualifyRecommendationBasket,recommendationRequirementsKey,type QualificationItem,type RecommendationRequirement} from "./recommendation_qualification";
const source_url="https://manufacturer.example/body",verified_at=2,verified_model="body";
const item:QualificationItem={item_id:"body",name:"Body",kind:"camera",quantity:1,spec:{item_name_canonical:"Body",description:"Reviewed body",source:"manufacturer-verified",source_url,verified_at,verified_model,camera_capabilities:{role:"interchangeable_lens",sensor_format:"full_frame",native_mount:"E",internal_4k:true,source_url,verified_at,verified_model,recording_modes:[{resolution:"uhd_4k",nominal_fps:[60],capture_format:"full_frame",full_width:true,internal:true,conditions:[],source_url,verified_at,verified_model}]}}};
const requirement:Extract<RecommendationRequirement,{kind:"camera"}>={kind:"camera",native_mount:"E",quantity:1,requirements:{recording:{resolution:"uhd_4k",min_fps:60,capture_format:"full_frame",full_width:true,internal:true}}};
describe("Native basket technical qualification",()=>{
 it("requires the selected physical item to supply the requested mode",()=>{
  expect(qualifyRecommendationBasket([requirement],[item])).toMatchObject({verified:true,groups:[{qualified_units:1}]});
  expect(qualifyRecommendationBasket([{...requirement,requirements:{recording:{...requirement.requirements.recording!,resolution:"dci_4k"}}}],[item])).toMatchObject({verified:false,groups:[{candidates:[{status:"unknown"}]}]});
 });
 it("cannot use a different body for each half of one requested category",()=>{
  expect(qualifyRecommendationBasket([requirement,{...requirement,native_mount:"L"}],[item,{...item,item_id:"other",name:"Other",spec:null}]).verified).toBe(false);
 });
 it("binds quantity, missing components and unreviewed provenance",()=>{
  expect(qualifyRecommendationBasket([{...requirement,quantity:2}],[item]).verified).toBe(false);
  expect(qualifyRecommendationBasket([{...requirement,quantity:2}],[{...item,quantity:2}]).verified).toBe(true);
  expect(qualifyRecommendationBasket([requirement],[]).verified).toBe(false);
  expect(qualifyRecommendationBasket([requirement],[{...item,spec:{...item.spec!,source:"v1-handwritten"}}]).verified).toBe(false);
 });
 it("does not treat optional extra gear as the qualified primary item",()=>{
  expect(qualifyRecommendationBasket([requirement],[item,{...item,item_id:"extra",name:"Extra",spec:null}]).verified).toBe(true);
  expect(qualifyRecommendationBasket([{...requirement,quantity:2}],[item,{...item,item_id:"extra",name:"Extra",spec:null}]).verified).toBe(false);
 });
 it("does not let a camera satisfy a lens requirement or an unknown lens satisfy autofocus",()=>{
  const lens:RecommendationRequirement={kind:"lens",quantity:1,native_mount:"E",requirements:{focus_mode:"autofocus"}};
  expect(qualifyRecommendationBasket([requirement,lens],[item]).verified).toBe(false);
  expect(qualifyRecommendationBasket([lens],[{item_id:"lens",name:"Lens",kind:"lens",quantity:1,native_mount:"E",spec:null}])).toMatchObject({verified:false,groups:[{candidates:[{status:"unknown"}]}]});
 });
 it("preserves distinct resolved requests and does not count a physical unit twice",()=>{
  const a={...requirement,target_item_id:"requested-one"},b={...requirement,target_item_id:"requested-two"};
  expect(qualifyRecommendationBasket([a,b],[item]).verified).toBe(false);
  expect(qualifyRecommendationBasket([a,b],[{...item,quantity:2}])).toMatchObject({verified:true,allocations:[{units:1},{units:1}]});
  expect(qualifyRecommendationBasket([a,b],[item,{...item,item_id:"other"}]).verified).toBe(true);
 });
 it("uses stable keys and preserves every distinct requirement",()=>{
  expect(recommendationRequirementsKey([requirement])).toBe(recommendationRequirementsKey([{quantity:1,requirements:{recording:{internal:true,full_width:true,capture_format:"full_frame",min_fps:60,resolution:"uhd_4k"}},native_mount:"E",kind:"camera"}]));
  expect(recommendationRequirementsKey([requirement])).not.toBe(recommendationRequirementsKey([{...requirement,quantity:2}]));
 });
});
