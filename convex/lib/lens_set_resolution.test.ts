import { describe, expect, it } from "vitest";
import { resolveLensSet, requestedLensSets } from "./lens_set_resolution";
const inventory = [35,50,85].map(f => ({_id:String(f),kind:"lens",name_canonical:`Anamorphic Great Joy lens ${f}mm`,aliases:[`Great Joy ${f}mm`],is_marketing_only:true,qty:0}));
describe("explicit inventory lens sets", () => {
  it("resolves the actual failed set spelling without asserting stock or ownership", () => {
    const result = resolveLensSet("Great Joy 35mm, 50mm and 85mm anamorphic lens set", inventory);
    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.items.map(i=>i._id)).toEqual(["35","50","85"]);
  });
  it("supports a shared mm suffix and keeps the requested order", () => {
    const result=resolveLensSet("Great Joy 85, 35 & 50mm lens set", inventory);
    expect(result?.ok && result.items.map(i=>i._id)).toEqual(["85","35","50"]);
    for(const name of ["Great Joy 35mm 50mm 85mm anamorphic lens set","Great Joy 35mm, 50mm, and 85mm anamorphic set","Great Joy 35, 50, & 85mm set"]){
      const set=resolveLensSet(name,inventory);expect(set?.ok && set.items.map(i=>i._id)).toEqual(["35","50","85"]);
    }
    expect(resolveLensSet("Great Joy 35 50 85mm set",inventory)).toBeNull();
  });
  it("does not silently select an owned variant over a marketing variant", () => {
    expect(resolveLensSet("Great Joy 35, 50 and 85mm set", [...inventory,{...inventory[0],_id:"another",is_marketing_only:false,qty:1}])).toEqual({ok:false,reason:"lens_set_identity_ambiguous"});
  });
  it("rejects missing focal lengths, duplicate focal lengths and different families", () => {
    expect(resolveLensSet("Great Joy 35, 50 and 100mm set",inventory)).toEqual({ok:false,reason:"lens_set_identity_unverified"});
    expect(resolveLensSet("Great Joy 35, 35 and 85mm set",inventory)).toEqual({ok:false,reason:"invalid_lens_set_focals"});
    expect(resolveLensSet("Blazar Remus 35, 50 and 85mm set",inventory)).toEqual({ok:false,reason:"lens_set_identity_unverified"});
  });
  it("does not turn a zoom, kit or unstated mount/aperture into the requested prime", () => {
    for (const suffix of ["Sony E", "f2.8", "kit"]) expect(resolveLensSet("Great Joy 35, 50 and 85mm set",inventory.map(i=>({...i,name_canonical:`${i.name_canonical} ${suffix}`,aliases:[]})))).toEqual({ok:false,reason:"lens_set_identity_unverified"});
    expect(resolveLensSet("Great Joy 35-85mm lens set",inventory)).toBeNull();
    expect(resolveLensSet("Great Joy 35, 50 and 85mm set",inventory.map(i=>({...i,name_canonical:`${i.name_canonical} Sony E`})))).toEqual({ok:false,reason:"lens_set_identity_unverified"});
  });
  it("anchors shorthand to an explicit latest request including quantities", () => {
    const sets=requestedLensSets("Can I add two Great Joy 35mm, 50mm and 85mm anamorphic lens sets for October?",inventory);
    expect(sets).toHaveLength(1);
    expect(sets[0].quantity).toBe(2);
    expect(sets[0].items.map(i=>i._id)).toEqual(["35","50","85"]);
    expect(requestedLensSets("Can I add five Great Joy 35, 50 and 85mm sets?",inventory)[0].quantity).toBe(5);
    expect(requestedLensSets("Can I add twenty-one Great Joy 35, 50 and 85mm sets?",inventory)).toEqual([]);
    expect(requestedLensSets("Can I add several Great Joy 35, 50 and 85mm sets?",inventory)).toEqual([]);
    expect(requestedLensSets("Can I rent a Great Joy anamorphic set?",inventory)).toEqual([]);
    expect(requestedLensSets("Can I rent a Remus 35, 50 and 85mm set?",inventory)).toEqual([]);
  });
});
