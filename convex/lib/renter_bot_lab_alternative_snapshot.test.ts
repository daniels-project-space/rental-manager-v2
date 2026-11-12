import { describe, expect, it, vi } from "vitest";
import { preparedAlternativeSnapshot } from "./renter_bot_lab_alternative_snapshot";

const now=1794480000000;
const original="kn740n15w16172sn1qj8h89gx586b2xf",candidate="kn74p93r60ndmmb0qghjqg84yh86abvh";
const siteSlug="sony-a7-iii-a7iii-4k-cinema-camera-full-frame-mirrorless-bod-1046235";
function source(change?:string) {
  return vi.fn(async (_url:string,request:RequestInit)=>{
    const path=JSON.parse(String(request.body)).path;
    const values:Record<string,unknown>={
      "hygglo_products:getByMasterItem":[{accountSlug:"dbcinema",productId:1046235,masterItemId:candidate,isPublished:true,isMarketingOnly:false,lastSyncedAt:now-1,prices:[{days:1,pricePerDay:18}]}],
      "listing_info_pool:admin_getDerivationBatch":{inventory:[{item_id:original,name_canonical:"BMPCC 6K Full Frame",kind:"camera",replacement_cost_gbp:2200},{item_id:candidate,name_canonical:"Sony A7 III",kind:"camera",replacement_cost_gbp:change==="value"?2500:900}]},
      "items:listForReconcile":[{_id:candidate,name:"Sony A7 III",status:"active",is_marketing_only:false,qty:1}],
      "catalog:getListingBySlug":{_id:"jx7a75qnq4gwpy9qnmaqz3tvbn885gq4",slug:siteSlug,bookable:change!=="unbookable",marketingOnly:false,inventoryFacts:{owned:true,reviewRequired:false},components:[{inventoryUnitId:change==="identity"?"wrong":"jn7chzv64ga6g1z43pxn0h5r6n885hgd",qty:1}]},
    };
    return new Response(JSON.stringify({status:"success",value:values[path]}));
  });
}
describe("source-verified Lab alternative",()=>{
  it("uses the exact account listing and current native replacement values",async()=>{
    const fetcher=source();
    expect(await preparedAlternativeSnapshot(fetcher as typeof fetch,now)).toEqual({original_value_gbp:2200,replacement_value_gbp:900,qty:1,daily_price_gbp:18,price_tiers:[{days:1,pricePerDay:18}],source_synced_at:now-1});
    const bodies=fetcher.mock.calls.map(([,request])=>JSON.parse(String(request.body)));
    expect(bodies.find(body=>body.path==="listing_info_pool:admin_getDerivationBatch").args.targets.every((target:{raw_title?:string})=>!!target.raw_title)).toBe(true);
  });
  it.each(["value","unbookable","identity"])("withholds the candidate when %s evidence fails",async change=>{
    expect(await preparedAlternativeSnapshot(source(change) as typeof fetch,now)).toBeNull();
  });
});
