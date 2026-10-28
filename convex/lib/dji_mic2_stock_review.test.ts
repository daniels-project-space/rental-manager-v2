import { describe, expect, it } from "vitest";
import type { Doc } from "../_generated/dataModel";
import { DJI_MIC2_OFFERS, djiMic2StockReview } from "./dji_mic2_stock_review";
import { resolveListingComponents } from "./listing_components";
import { canonicalListingAllocation } from "./canonical_listing_allocation";

const fixture=()=>{
  const items=[{_id:"mic2",name_canonical:"DJI Mic 2 wireless",kind:"audio",unit_kind:"set",status:"active",is_marketing_only:false,qty:1,compatibility:{included_with_rental:["2x transmitter","1x receiver","1x charging case"]}}] as unknown as Doc<"items">[];
  const products=DJI_MIC2_OFFERS.map(([account,id])=>({_id:`p-${id}`,accountSlug:account,productId:id,name:`DJI Mic 2 Wireless Kit ${id}`,
    description:account==="dbcinema"?"Wireless recording system":`${account==="leo"?"Also included:":"In this kit:"}\n- DJI Mic 2 Receiver\n- 2x DJI Mic 2 Transmitters\n- DJI Mic 2 Charging Case\n- 2x Rode lavalier microphones`,isMarketingOnly:true})) as unknown as Doc<"hygglo_products">[];
  const overrides=[{account_slug:"dbcinema",product_id:1044310,components:[{item_id:"mic2",qty:1}]},{account_slug:"leo",product_id:1097516,components:[{item_id:"mic2",qty:1}]}] as unknown as Doc<"listing_resolution_override">[];
  return {items,products,overrides};
};
function repair() {
  const {items,products,overrides}=fixture(), plan=djiMic2StockReview(items,products,overrides);
  for(const row of plan.items)Object.assign(items.find(i=>i._id===row.id)!,row.patch);
  for(const row of plan.products)Object.assign(products.find(p=>p._id===row.id)!,row.patch);
  for(const row of plan.inserts)overrides.push(row as Doc<"listing_resolution_override">);
  return {items,products,overrides,plan};
}

describe("DJI Mic 2 shared stock and packing evidence",()=>{
  it("links all three accounts to one owned kit without inventing wired lavalier pools",()=>{
    const {items,products,overrides,plan}=repair();
    expect(plan.inserts).toHaveLength(1);
    for(const [account,id]of DJI_MIC2_OFFERS){
      const product=products.find(p=>p.accountSlug===account&&p.productId===id)!;
      const override=overrides.find(o=>o.account_slug===account&&o.product_id===id)!;
      const result=resolveListingComponents(items,override.components,String(product.masterItemId),1,product.description,undefined,product.name);
      expect(product.isMarketingOnly).toBe(false);
      expect(result.components.map(c=>({id:c.item_id,qty:c.units_per_listing}))).toEqual([{id:"mic2",qty:1}]);
      expect(result.applied_stock_rules.some(rule=>rule.packing_review_required)).toBe(true);
      if(account==="dbcinema")expect(result).toMatchObject({complete:true,owned:true});
      else { expect(result.complete).toBe(false);expect(result.coverage?.unresolved).toContain("2x Rode lavalier microphones"); }
    }
    expect(items[0].qty).toBe(1);
    expect(djiMic2StockReview(items,products,overrides)).toEqual({items:[],products:[],inserts:[]});
  });
  it("keeps the known mic pool in existing rental allocation even if a seller accessory needs review",()=>{
    const {items,products,overrides}=repair();
    const allocation=canonicalListingAllocation(items,overrides,products,[]);
    for(const [account,id]of DJI_MIC2_OFFERS) expect(allocation.get(`${account}#${id}`)).toEqual([{item_id:"mic2",qty:1}]);
  });
  it("preserves owner exclusions and refuses an unexpected existing mapping",()=>{
    const {items,products,overrides}=fixture();
    products[0].isMarketingOnlyOverride=true;
    expect(()=>djiMic2StockReview(items,products,overrides)).toThrow("owner exclusion");
    delete products[0].isMarketingOnlyOverride;
    overrides[0].components=[{item_id:"other" as never,qty:1}];
    expect(()=>djiMic2StockReview(items,products,overrides)).toThrow("owner mapping");
  });
});
