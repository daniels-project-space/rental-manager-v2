import {describe,it,expect} from "vitest";
import {verifiedLensCapabilities,meetsLensRequirements,requestedLensRequirements,reconcileLensRequirements} from "./lens_requirements";
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
 it("preserves explicit properties omitted or contradicted by the tool caller",()=>{
  expect(reconcileLensRequirements(undefined,["wide-angle autofocus lens"])).toEqual({requirements:{wide_angle:true,focus_mode:"autofocus"},conflict:false});
  expect(reconcileLensRequirements({focus_mode:"manual_focus"},["I need autofocus"] ).conflict).toBe(true);
  expect(reconcileLensRequirements(undefined,["autofocus or manual-focus"] ).conflict).toBe(true);
  expect(requestedLensRequirements("I don't need autofocus, but need a wide-angle lens")).toEqual({wide_angle:true});
  expect(requestedLensRequirements("wide-angle lens, no fisheye")).toEqual({wide_angle:true,excluded_projections:["fisheye"]});
  expect(requestedLensRequirements("I don't want autofocus")).toEqual({focus_mode:"manual_focus"});
  expect(requestedLensRequirements("AF wide-angle lens")).toEqual({focus_mode:"autofocus",wide_angle:true});
  expect(reconcileLensRequirements(undefined,["I don't need autofocus; I want manual-focus"])).toEqual({requirements:{focus_mode:"manual_focus"},conflict:false});
  expect(meetsLensRequirements({...verifiedLensCapabilities(spec,"Exact lens")!,projection:"fisheye"},{excluded_projections:["fisheye"]})).toBe(false);
  expect(meetsLensRequirements({...verifiedLensCapabilities(spec,"Exact lens")!,projection:"anamorphic"},{excluded_projections:["fisheye"]})).toBe(true);
 });
});
