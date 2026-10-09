import { describe, expect, it } from "vitest";
import { resolveListingComponents } from "./listing_inventory";
import { declaredLensIdentity } from "./declared_lens_identity";
import { createBundleMappingContext } from "./bundle_mapping";
const lens = {_id:"gm",kind:"lens",name_canonical:"Sony GM 70-200mm f2.8",aliases:["Sony 70-200mm f2.8 GM"],status:"active",is_marketing_only:false,qty:2};
describe("declared lens model identity",()=>{
 it("reuses identity within one snapshot while preserving quantities and rejecting a different snapshot",()=>{
  const inventory=[lens],context=createBundleMappingContext(inventory);
  const first=resolveListingComponents(inventory as any,[{item_id:"gm",qty:1}],"gm",1,"Included in this rental: • 1x Sony 70-200mm f2.8 zoom lens",context);
  const later=resolveListingComponents(inventory as any,[{item_id:"gm",qty:1}],"gm",1,"Included in this rental: • 3x Sony 70-200mm f2.8 zoom lens",context);
  expect(first.components[0].units_per_listing).toBe(1);expect(later.components[0].units_per_listing).toBe(3);expect(context.matches.size).toBe(1);
  const changed=[{...lens,is_marketing_only:true}];
  expect(()=>resolveListingComponents(changed as any,[{item_id:"gm",qty:1}],"gm",1,"Included in this rental: • 1x Sony 70-200mm f2.8 zoom lens",context)).toThrow(/different inventory snapshot/);
  expect(resolveListingComponents(changed as any,[{item_id:"gm",qty:1}],"gm",1,"Included in this rental: • 1x Sony 70-200mm f2.8 zoom lens",createBundleMappingContext(changed)).owned).toBe(false);
 });
 it("automatically links a complete declared kit to existing pools without creating quantities",()=>{
  const body={...lens,_id:"body",kind:"camera",name_canonical:"Sony FX3",aliases:[],qty:4};
  const inventory=[body,lens];const text="Included in this rental: • 1x Sony FX3 • 2x Sony 70-200mm f2.8 zoom lenses";
  const before=JSON.stringify(inventory),r=resolveListingComponents(inventory as any,undefined,"body",1,text);
  expect(r).toMatchObject({complete:true,owned:true,source:"declared_contents"});expect(r.components.map(c=>[c.item_id,c.units_per_listing])).toEqual([["body",1],["gm",2]]);
  const completed=resolveListingComponents(inventory as any,[{item_id:"body",qty:1}],"body",1,text);
  expect(completed).toMatchObject({complete:true,owned:true,declared_components_added:[{item_id:"gm",qty:2}]});
  expect(JSON.stringify(inventory)).toBe(before);
 });
 it("does not certify incomplete, ambiguous or legacy ownership declarations, or erase an owner exclusion",()=>{
  const body={...lens,_id:"body",kind:"camera",name_canonical:"Sony FX3",aliases:[],qty:4};
  const text="Included in this rental: • 1x Sony FX3 • 2x Sony 70-200mm f2.8 zoom lenses";
  expect(resolveListingComponents([body,lens] as any,[],"body",1,text).owned).toBe(false);
  expect(resolveListingComponents([body,{...lens,is_marketing_only:undefined}] as any,undefined,"body",1,text).owned).toBeNull();
  expect(resolveListingComponents([body,lens] as any,undefined,"body",1,"Included in this rental: • 1x Sony 70-200mm f2.8 lens").owned).toBeNull();
  expect(resolveListingComponents([body,lens] as any,undefined,"body",1,text+" • 1x Unknown monitor").owned).toBeNull();
  expect(resolveListingComponents([body,lens] as any,[{item_id:"gm",qty:NaN}],"body",1,text).complete).toBe(false);
 });
 it.each(["Sony 70-200mm f2.8 lens","Sony 70-200 mm f/2.8 zoom lens","70-200mm f2.8 zoom lens"])("matches the unique recorded focal/aperture model: %s",name=>{
  const result=resolveListingComponents([lens] as any,[{item_id:"gm",qty:1}],"gm",1,"Included in this rental: • 1x "+name);
  expect(result).toMatchObject({complete:true,owned:true,coverage:{missing:[],unresolved:[]}});
 });
 it.each(["Sony 70-200mm f4 lens","Canon 70-200mm f2.8 lens","Sony 70-200mm f2.8 II lens","Sony 70-200mm t2.8 lens","Sony 70mm f2.8 lens"])("never accepts a different stated model: %s",name=>{
  expect(declaredLensIdentity(name,[lens]).item).toBeNull();
 });
 it("keeps omitted maker, generation and aperture ambiguous across real master rows",()=>{
  for(const other of [{...lens,_id:"other",name_canonical:"Sony GM 70-200mm f2.8 II",aliases:[]},{...lens,_id:"other",name_canonical:"Sony GM 70-200mm f4",aliases:[]},{...lens,_id:"other",name_canonical:"Canon 70-200mm f2.8",aliases:[]}]){
   const name=other.name_canonical.includes("Canon")?"70-200mm f2.8 lens":other.name_canonical.includes("f4")?"Sony 70-200mm zoom lens":"Sony 70-200mm f2.8 lens";
   expect(declaredLensIdentity(name,[lens,other]).item).toBeNull();
  }
 });
 it("does not treat two lenses in one declaration as a single owned lens",()=>{
  expect(declaredLensIdentity("Sony 70-200mm + 24-70mm f2.8 lenses",[lens]).item).toBeNull();
 });
 it("does not reinterpret millimetre hardware as a lens",()=>{
  expect(declaredLensIdentity("15mm support rods",[lens]).explicit).toBe(false);
 });
 it("keeps explicit mounts and known marketing ownership authoritative",()=>{
  const ef={...lens,_id:"ef",name_canonical:"Canon EF 24-105mm f4",aliases:[],lens_mount:"EF"};
  const rf={...ef,_id:"rf",name_canonical:"Canon RF 24-105mm f4",lens_mount:"RF"};
  expect(declaredLensIdentity("Canon RF 24-105mm f4 lens",[ef,rf]).item?._id).toBe("rf");
  expect(declaredLensIdentity("Canon 24-105mm f4 lens",[ef,rf]).item).toBeNull();
  const result=resolveListingComponents([{...lens,is_marketing_only:true}] as any,[{item_id:"gm",qty:1}],"gm",1,"Included in this rental: • 1x Sony 70-200mm f2.8 zoom lens");
  expect(result.owned).toBe(false);
 });
});
