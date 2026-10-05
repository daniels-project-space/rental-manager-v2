import {describe,it,expect} from "vitest";
import {basketSpecificationOwnerChecks,qualifyRecommendationBasket,recommendationRequirementsKey,type QualificationItem,type RecommendationRequirement} from "./recommendation_qualification";
const source_url="https://manufacturer.example/body",verified_at=2,verified_model="body";
const item:QualificationItem={item_id:"body",name:"Body",kind:"camera",quantity:1,spec:{item_name_canonical:"Body",description:"Reviewed body",source:"manufacturer-verified",source_url,verified_at,verified_model,camera_capabilities:{role:"interchangeable_lens",sensor_format:"full_frame",native_mount:"E",internal_4k:true,source_url,verified_at,verified_model,recording_modes:[{resolution:"uhd_4k",nominal_fps:[60],capture_format:"full_frame",full_width:true,internal:true,conditions:[],source_url,verified_at,verified_model}]}}};
const requirement:Extract<RecommendationRequirement,{kind:"camera"}>={kind:"camera",native_mount:"E",quantity:1,requirements:{recording:{resolution:"uhd_4k",min_fps:60,capture_format:"full_frame",full_width:true,internal:true}}};
describe("Native basket technical qualification",()=>{
 it("groups missing lens facts so one durable scope retains all affected physical lenses",()=>{
  const lens:QualificationItem={item_id:"lens-a",name:"Lens A",kind:"lens",quantity:1,native_mount:"E",spec:null};
  const dates={start_date:"2026-10-20",end_date:"2026-10-21"};
  const checks=basketSpecificationOwnerChecks([], [{...item,native_mount:"E"},lens,{...lens,item_id:"lens-b"}],dates);
  expect(checks).toEqual([{kind:"lens_recommendation",requirements:{coverage:"full_frame"},candidate_item_ids:["lens-a","lens-b"],lens_mount:null,...dates,quantity:1}]);
  const separate=basketSpecificationOwnerChecks([], [{...item,native_mount:"E"},lens,{...lens,item_id:"lens-b",quantity:2}],dates);
  expect(separate).toHaveLength(2);expect(separate.map(c=>c.quantity)).toEqual([1,2]);
 });
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

describe("selected camera and lens setup qualification",()=>{
 const body={...item,native_mount:"E"};
 const lens:QualificationItem={item_id:"lens",name:"Lens",kind:"lens",quantity:1,native_mount:"E",spec:{item_name_canonical:"Lens",description:"Reviewed lens",source:"manufacturer-verified",source_url,verified_at,verified_model:"lens",lens_capabilities:{focus_mode:"autofocus",coverage:"full_frame",source_url,verified_at,verified_model:"lens"}}};
 const criteria:RecommendationRequirement[]=[{kind:"camera",quantity:1,requirements:{internal_4k:true}},{kind:"lens",quantity:1,requirements:{focus_mode:"autofocus"}}];
 it("checks paired mounts even when search criteria omitted them, including an empty criteria ledger",()=>{
  expect(qualifyRecommendationBasket(criteria,[body,lens])).toMatchObject({verified:true,setup:{status:"match"}});
  expect(qualifyRecommendationBasket([],[body,lens])).toMatchObject({verified:true,setup:{applied:true,status:"match"}});
  for(const requirements of [criteria,[]])expect(qualifyRecommendationBasket(requirements,[body,{...lens,native_mount:"PL"}])).toMatchObject({verified:false,setup:{status:"unknown",unknown:["mount_adapter",...(requirements.length?["adapted_autofocus"]:[])]}});
 });
 it("does not borrow lens coverage from the camera's full-frame sensor",()=>{
  const unknown={...lens,spec:{...lens.spec!,lens_capabilities:{...lens.spec!.lens_capabilities!,coverage:undefined}}};
  expect(qualifyRecommendationBasket(criteria,[body,unknown])).toMatchObject({verified:false,setup:{unknown:["lens_sensor_coverage"]}});
  const cropped=[{kind:"camera" as const,quantity:1,requirements:{recording:{resolution:"uhd_4k" as const,capture_format:"aps_c" as const}}}];
  expect(qualifyRecommendationBasket(cropped,[body,unknown]).setup.unknown).toContain("lens_sensor_coverage");
 });
 it("requires current matching mount identity and a known camera/lens assignment",()=>{
  expect(qualifyRecommendationBasket(criteria,[{...body,native_mount:"L"},lens])).toMatchObject({verified:false,setup:{mismatched:["camera_mount_identity"]}});
  expect(qualifyRecommendationBasket(criteria,[body,{...body,item_id:"second",native_mount:"L"},lens]).setup.unknown).toContain("camera_lens_assignment");
  expect(qualifyRecommendationBasket(criteria,[{...body,spec:null},lens]).verified).toBe(false);
 });
 it("counts a selected mechanical adapter without treating it as autofocus evidence",()=>{
  const pl={...lens,native_mount:"PL"};
  const adapter:QualificationItem={item_id:"adapter",name:"PL to E mount",kind:"accessory",quantity:1,spec:null};
  expect(qualifyRecommendationBasket(criteria,[body,pl,adapter])).toMatchObject({verified:false,setup:{unknown:["adapted_autofocus"]}});
  expect(qualifyRecommendationBasket([],[body,pl,adapter])).toMatchObject({verified:true,setup:{status:"match"}});
  expect(qualifyRecommendationBasket([],[{...body,quantity:2},{...pl,quantity:2},adapter])).toMatchObject({verified:false,setup:{mismatched:["missing_mount_adapter"]}});
 });
});
