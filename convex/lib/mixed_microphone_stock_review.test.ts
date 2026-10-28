import {describe,expect,it} from "vitest";
import type {Doc} from "../_generated/dataModel";
import {mixedMicrophoneStockReview} from "./mixed_microphone_stock_review";
import {resolveListingComponents} from "./listing_components";
import {canonicalListingAllocation} from "./canonical_listing_allocation";
function fixture(){
 const items=[{_id:"dji",name_canonical:"DJI Wireless Mics",unit_kind:"set",kind:"audio",status:"active",is_marketing_only:false,qty:1},{_id:"rode",name_canonical:"Rode Wireless Mic Pro set",unit_kind:"set",kind:"audio",status:"active",is_marketing_only:false,qty:2}] as unknown as Doc<"items">[];
 const product={_id:"product",accountSlug:"dbcinema",productId:1027212,name:"3x Dji mic wireless receiver Transmitter +2x rode wireless pro microphone sound",description:"A full set for large group interviews and conferences",masterItemId:"rode"} as unknown as Doc<"hygglo_products">;
 const override={_id:"override",account_slug:"dbcinema",product_id:1027212,components:[{item_id:"dji",qty:1}]} as unknown as Doc<"listing_resolution_override">;return {items,product,override};
}
describe("mixed wireless microphone bundle review",()=>{
 it("holds the two named Rode sets while leaving the uncertain bundle unconfirmed",()=>{
  const {items,product,override}=fixture(),plan=mixedMicrophoneStockReview(items,product,override);expect(plan.item).not.toBeNull();expect(plan.override).not.toBeNull();
  items[1].listing_stock_rules=plan.item!.listing_stock_rules;override.components=plan.override!.components;
  const result=resolveListingComponents(items,override.components,String(product.masterItemId),1,product.description,undefined,product.name);
  expect(result.complete).toBe(false);expect(result.owned).toBeNull();expect(result.applied_stock_rules.some(r=>r.stock_review_required)).toBe(true);
  expect(result.components.map(c=>({item_id:c.item_id,qty:c.units_per_listing}))).toEqual([{item_id:"dji",qty:1},{item_id:"rode",qty:2}]);
  expect(canonicalListingAllocation(items,[override],[product],[]).get("dbcinema#1027212")).toEqual([{item_id:"dji",qty:1},{item_id:"rode",qty:2}]);
  expect(mixedMicrophoneStockReview(items,product,override)).toEqual({item:null,override:null});expect(items.map(i=>i.qty)).toEqual([1,2]);
 });
 it("refuses changed identities, stock, or unexpected manual mappings",()=>{
  const {items,product,override}=fixture();override.components=[{item_id:"other" as never,qty:1}];expect(()=>mixedMicrophoneStockReview(items,product,override)).toThrow("mapping needs review");
  override.components=[{item_id:"dji" as never,qty:1}];items[1].qty=1;expect(()=>mixedMicrophoneStockReview(items,product,override)).toThrow("Review master stock");
 });
});
