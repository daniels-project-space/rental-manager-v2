import {describe,it,expect} from "vitest";
import {verifiedLensCapabilities,meetsLensRequirements,assessLensRequirements} from "./lens_requirements";
const spec={item_name_canonical:"Exact lens",description:"Reviewed",source:"manufacturer-verified",source_url:"https://manufacturer.example/model",verified_model:"model",verified_at:10,lens_capabilities:{focal_min_mm:16,focal_max_mm:35,max_aperture_f:2.8,focus_mode:"autofocus" as const,wide_angle:true,coverage:"full_frame" as const,verified_model:"model",source_url:"https://manufacturer.example/model",verified_at:10}};
describe("verified lens requirement boundary",()=>{
 it("requires exact identity and current model/source provenance",()=>{
  expect(verifiedLensCapabilities(spec,"Other lens")).toBeNull();
  for(const patch of [{verified_model:"other"},{source_url:"https://other.example/model"},{verified_at:9}])expect(verifiedLensCapabilities({...spec,lens_capabilities:{...spec.lens_capabilities,...patch}},"Exact lens")).toBeNull();
  expect(verifiedLensCapabilities({...spec,source:"grok-generated"},"Exact lens")).toBeNull();
  expect(verifiedLensCapabilities({...spec,lens_capabilities:undefined},"Exact lens")).toBeNull();
 });
 it("checks focus, range, coverage and maximum aperture before stock",()=>{
  const cap=verifiedLensCapabilities(spec,"Exact lens");
  expect(meetsLensRequirements(cap,{focus_mode:"autofocus",wide_angle:true,focal_mm:24,max_wide_focal_mm:16,max_aperture_f:2.8,coverage:"full_frame"})).toBe(true);
  for(const req of [{focus_mode:"manual_focus" as const},{focal_mm:90},{max_wide_focal_mm:11},{max_aperture_f:1.8},{macro:true},{projection:"fisheye" as const}])expect(meetsLensRequirements(cap,req)).toBe(false);
 });
 it("unknown does not prove a requested property and f-stops are not T-stops",()=>{
  const cap=verifiedLensCapabilities(spec,"Exact lens");
  expect(meetsLensRequirements(cap,{max_aperture_t:2.8})).toBe(false);
  expect(meetsLensRequirements(null,{focus_mode:"autofocus"})).toBe(false);
  expect(meetsLensRequirements(null,{})).toBe(true);
  expect(meetsLensRequirements(null,{excluded_projections:[]})).toBe(true);
 });
 it("rejects invalid profile ranges and numeric requirements",()=>{
  expect(verifiedLensCapabilities({...spec,lens_capabilities:{...spec.lens_capabilities,focal_min_mm:40}},"Exact lens")).toBeNull();
  expect(verifiedLensCapabilities({...spec,lens_capabilities:{...spec.lens_capabilities,focal_min_mm:0}},"Exact lens")).toBeNull();
  expect(meetsLensRequirements(verifiedLensCapabilities(spec,"Exact lens"),{focal_mm:-1})).toBe(false);
 });
 it("distinguishes missing evidence from a proven mismatch",()=>{
  const cap=verifiedLensCapabilities(spec,"Exact lens");
  expect(assessLensRequirements(cap,{focus_mode:"autofocus",wide_angle:true})).toEqual({status:"match",unknown:[],mismatched:[]});
  expect(assessLensRequirements(null,{focus_mode:"autofocus",wide_angle:true})).toEqual({status:"unknown",unknown:["focus_mode","wide_angle"],mismatched:[]});
  expect(assessLensRequirements({...cap!,focus_mode:"manual_focus"},{focus_mode:"autofocus",macro:true})).toEqual({status:"mismatch",unknown:["macro"],mismatched:["focus_mode"]});
  expect(assessLensRequirements(cap,{max_aperture_t:2.8}).status).toBe("unknown");
  expect(assessLensRequirements(cap,{focal_mm:90}).status).toBe("mismatch");
 });
});
