import { describe, expect, it } from "vitest";
import type { Doc } from "../_generated/dataModel";
import { principalConsentComponents } from "./offering_consent_identity";

const item=(value:Record<string,unknown>)=>value as unknown as Doc<"items">;
const camera=item({_id:"camera",name_canonical:"Sony A7 III",kind:"camera",status:"active",is_marketing_only:false,
  supplied_stock:[{item_id:"battery",qty:3,source:"owner confirmed"}],
  compatibility:{included_with_rental:["1× EF to L adapter"]}});
const battery=item({_id:"battery",name_canonical:"Sony NP-FZ100 batteries",kind:"accessory",status:"active",is_marketing_only:false,track_independent_stock:true,unit_kind:"unit"});
const adapter=item({_id:"adapter",name_canonical:"EF to L mount",kind:"accessory",status:"active",is_marketing_only:false,aliases:["EF to L adapter"]});
const lens=item({_id:"lens",name_canonical:"Sony 28-70mm",kind:"lens",status:"active",is_marketing_only:false});
const inventory=[camera,battery,adapter,lens];
describe("principal equipment in a listing's consent identity",()=>{
  it("keeps automatically supplied batteries and adapters in stock but outside the camera's main identity",()=>{
    const mapped=[{item:camera,qty:1},{item:battery,qty:3},{item:adapter,qty:1}];
    expect(principalConsentComponents(mapped,inventory).map(row=>row.item._id)).toEqual(["camera"]);
  });
  it("retains a separate lens or extra battery units as part of the offered identity",()=>{
    const mapped=[{item:camera,qty:1},{item:battery,qty:4},{item:adapter,qty:1},{item:lens,qty:1}];
    expect(principalConsentComponents(mapped,inventory).map(row=>row.item._id)).toEqual(["camera","battery","lens"]);
  });
  it("retains an accessory offered on its own",()=>{
    expect(principalConsentComponents([{item:adapter,qty:1}],inventory).map(row=>row.item._id)).toEqual(["adapter"]);
  });
});
