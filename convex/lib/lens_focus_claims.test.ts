import {describe,it,expect} from "vitest";
import {unsupportedLensFocusClaims,type LensFocusEvidence} from "./lens_focus_claims";
import {equipmentClaimProfiles,equipmentClaimsNeedProfiles} from "./equipment_claim_profiles";
import {guardDraft} from "./draft_guard";
const lens:LensFocusEvidence={names:["TTArtisan 11mm f2.8 Fisheye (Sony E)"],capabilities:{model:"TTArtisan 11mm f/2.8",source_url:"https://ttartisan.com/11mm",focus_mode:"manual_focus"}};
const sony:LensFocusEvidence={names:["Sony FE 16-35mm F2.8 GM"],capabilities:{model:"SEL1635GM",source_url:"https://sony.com/lens",focus_mode:"autofocus",manual_focus_available:true}};
const check=(text:string,evidence=[lens,sony],initial=[lens.names[0]])=>unsupportedLensFocusClaims(text,evidence,initial,["Sony FX3","FX3"]);
describe("reviewed lens focus assertions",()=>{
 it("rejects the actual manual lens autofocus edit and accepts its real limitations",()=>{
  expect(check("The TTArtisan 11mm f/2.8 fisheye (E) supports autofocus.")).not.toEqual([]);
  expect(check("The TTArtisan 11mm f/2.8 fisheye (E) is manual-focus only.")).toEqual([]);
  expect(check("It does not support autofocus.")).toEqual([]);
  expect(check("It's a manual-focus lens.")).toEqual([]);
  expect(check("It's an autofocus lens.")).not.toEqual([]);
  expect(check("It has autofocus.")).not.toEqual([]);
 });
 it("keeps manufacturer, mount and generation identities separate",()=>{
  for(const name of ["Sony 11mm f/2.8 fisheye","TTArtisan 11mm f/2.8 fisheye (RF)","Sony FE 16-35mm F2.8 GM II"])expect(check(`The ${name} supports autofocus.`)).not.toEqual([]);
  expect(check("The Sony FE 16-35mm F2.8 GM supports autofocus.")).toEqual([]);
 });
 it("distinguishes manual override from manual-only and checks each clause",()=>{
  expect(check("The Sony FE 16-35mm F2.8 GM supports manual focus.")).toEqual([]);
  expect(check("The Sony FE 16-35mm F2.8 GM is manual-focus only.")).not.toEqual([]);
  expect(check("The TTArtisan 11mm f2.8 Fisheye (Sony E) supports autofocus, but the Sony FE 16-35mm F2.8 GM supports autofocus.")).toHaveLength(1);
 });
 it("does not turn questions or requirements into promised lens features",()=>{
  for(const text of ["Does the TTArtisan lens support autofocus?","I'll check whether it supports autofocus.","If you need autofocus, let me know.","The Sony FX3 has autofocus."])expect(check(text)).toEqual([]);
 });
 it("requires current reviews and an unambiguous unnamed lens",()=>{
  expect(check("It supports autofocus.",[],[])).not.toEqual([]);
  expect(check("It is manual-focus only.",[{...lens,capabilities:null}])).not.toEqual([]);
  expect(check("It supports autofocus.",[lens,sony],[])).not.toEqual([]);
 });
 it("connects the exact same rejection to the production draft guard",()=>{
  const result=guardDraft("The TTArtisan 11mm f/2.8 fisheye (E) supports autofocus.",{lensEvidence:[lens],history:[],lastRenterMessage:"Does the lens have autofocus?"});
  expect(result.flags.some(f=>f.type==="LENS_FOCUS_HALLUCINATION"&&f.severity==="high")).toBe(true);
 });
});
describe("current Native equipment profile projection",()=>{
 const item={_id:"lens",name_canonical:lens.names[0],kind:"lens",status:"active",qty:1,is_marketing_only:false};
 const spec={item_id:"lens",item_name_canonical:item.name_canonical,description:"Manual focus lens",source:"manufacturer-verified",source_url:"https://ttartisan.com/11mm",verified_model:"TTArtisan 11mm f/2.8",verified_at:1,lens_capabilities:{focus_mode:"manual_focus",verified_model:"TTArtisan 11mm f/2.8",source_url:"https://ttartisan.com/11mm",verified_at:1}};
 it("retains known identity without inventing capabilities from conflicting reviews",()=>{
  expect(equipmentClaimProfiles([item] as any,[spec] as any).lenses[0].capabilities?.focus_mode).toBe("manual_focus");
  expect(equipmentClaimProfiles([item] as any,[spec,spec] as any).lenses[0].capabilities).toBeNull();
  expect(equipmentClaimProfiles([{...item,is_marketing_only:true}] as any,[spec] as any).lenses).toEqual([]);
 });
 it("uses one trigger for compact modes, focus assertions and camera features",()=>{
  for(const text of ["4K120fps","4K120p","UHD 4K","built-in ND","autofocus","manual-focus"])expect(equipmentClaimsNeedProfiles(text)).toBe(true);
  expect(equipmentClaimsNeedProfiles("Thanks, that works.")).toBe(false);
 });
});
