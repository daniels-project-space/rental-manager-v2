import { describe, expect, it } from "vitest";
import { withBookingAdditionPreview } from "./renter-pricing-preview";
import { withRenterToolScope, currentRenterToolScope } from "./renter-tool-scope";
import { renterToolReceipts, stockReceipts } from "./renter-tool-evidence";

const pricing={found:true,account_slug:"leo",source:"hygglo_tier",product_id:1172895,matched_canonical:"BMPCC 6K Pro",quantity:1,listed_total_gbp:70};
const scope={threadId:"__probe__current",accountSlug:"leo",requestMessageId:"current-renter"};
describe("pricing with a Native booking preview",()=>{
  it("uses server thread and inbound scope plus the Native canonical item and quantity",async()=>{
    let received:unknown;
    const proposal={ok:true,source:"native_lab_proposal",preview_only:true,thread_id:scope.threadId,additional_cost_gbp:70,quote:{total_gbp:194},addition_quote:{lines:[{product_id:1172895,qty:1}]}};
    const result=await withRenterToolScope(scope,()=>withBookingAdditionPreview(pricing,currentRenterToolScope(),async args=>{received=args;return proposal;}));
    expect(received).toEqual({thread_id:scope.threadId,request_message_id:scope.requestMessageId,action:"add_item",item_name:"BMPCC 6K Pro",product_id:1172895,qty:1,preview_only:true});
    expect(result).toEqual({...pricing,booking_addition_preview:proposal});
    expect(renterToolReceipts([{toolName:"lookup_pricing",toolCallId:"price",result}])).toContainEqual({tool:"quote_booking_addition",call_id:"price:booking-preview",result:proposal});
  });
  it("never attempts a Lab mutation for a real thread, missing scope, wrong account, unverified estimate or an unmapped bundle",async()=>{
    let calls=0;const preview=async()=>{calls++;return {};};
    for(const [p,s] of [[pricing,{...scope,threadId:"real-order"}],[pricing,undefined],[{...pricing,account_slug:"diogo"},scope],[{...pricing,source:"curated_catalog"},scope],[{...pricing,matched_canonical:undefined},scope],[{...pricing,found:false},scope],[{...pricing,quantity:0},scope]] as const)
      expect(await withBookingAdditionPreview(p,s,preview)).toEqual(p);
    expect(calls).toBe(0);
  });
  it("retains a refused basket's negative stock proof without turning the proposal into a successful quote",async()=>{
    const stock={source:"shared_inventory_confirmed_rentals",item_id:"pool",item_name:"NP-F570 batteries",available:false,owned:true,start_date:"2026-10-20",end_date:"2026-10-21",requested_units:10,free_units:8,checked_at:12345};
    const result=await withBookingAdditionPreview(pricing,scope,async()=>({ok:false,error:"insufficient units",stock_receipts:[stock]}));
    const receipts=renterToolReceipts([{toolName:"lookup_pricing",toolCallId:"price",result}]);
    expect(receipts.some(r=>r.tool==="quote_booking_addition")).toBe(false);
    expect(stockReceipts(receipts).map(r=>r.result)).toEqual([stock]);
    expect(renterToolReceipts([{toolName:"lookup_pricing",args:{...pricing,booking_addition_preview:{ok:true,quote:{total_gbp:194}}}}])).toEqual([]);
  });
  it("does not invent a proposal when the backend fails",async()=>{
    const result:any=await withBookingAdditionPreview(pricing,scope,async()=>{throw Error("unavailable");});
    expect(result.listed_total_gbp).toBe(70);
    expect(result.booking_addition_preview).toMatchObject({ok:false,error_code:"proposal_quote_unavailable"});
    expect(renterToolReceipts([{toolName:"lookup_pricing",result}]).some(r=>r.tool==="quote_booking_addition")).toBe(false);
  });
  it("never replaces a priced bundle or different quantity with a base-body quote",async()=>{
    for(const line of [{product_id:999,qty:1},{product_id:1172895,qty:2}]) {
      const result:any=await withBookingAdditionPreview(pricing,scope,async()=>({ok:true,quote:{total_gbp:194},addition_quote:{lines:[line]}}));
      expect(result.booking_addition_preview).toMatchObject({ok:false,error_code:"offering_requires_exact_quote"});
      expect(result.booking_addition_preview.quote).toBeUndefined();
    }
  });
  it("quotes a copied bundle title with its exact Native product rather than a guessed primary body",async()=>{
    let received:any;
    const bundle={...pricing,matched_canonical:undefined,matched_listing:"Selected camera and lens kit"};
    const result:any=await withBookingAdditionPreview(bundle,scope,async args=>{received=args;return {ok:true,addition_quote:{lines:[{product_id:1172895,qty:1}]}};});
    expect(received.item_name).toBe(bundle.matched_listing);
    expect(received.product_id).toBe(bundle.product_id);
    expect(result.booking_addition_preview.ok).toBe(true);
  });
  it("recovers a separately priced body after a full-kit conflict and routes its own Native receipts",async()=>{
    const selected={...pricing,product_id:1107037,matched_canonical:undefined,matched_listing:"Pro + Canon kit",days:2,listed_total_gbp:90,
      component_base_offerings:[{name:"BMPCC 6K Pro",listing_name:"Pro body kit",product_id:1172895}]};
    const lookups:unknown[]=[]; const previews:unknown[]=[];
    const result:any=await withBookingAdditionPreview(selected,scope,async args=>{
      previews.push(args);
      return args.product_id===1107037 ? {ok:false,error:"Only one Canon lens"} :
        {ok:true,additional_cost_gbp:70,quote:{total_gbp:194},addition_quote:{lines:[{product_id:1172895,qty:1}]}};
    },async args=>{lookups.push(args);return {...pricing,days:2,matched_listing:"Pro body kit"};});
    expect(lookups).toEqual([{item_name:"Pro body kit",product_id:1172895,account_slug:"leo",days:2,quantity:1}]);
    expect(previews).toHaveLength(2);
    expect(result.listed_total_gbp).toBe(90);
    expect(result.booking_addition_preview.ok).toBe(false);
    expect(result.component_base_offering_quotes[0]).toMatchObject({product_id:1172895,listed_total_gbp:70,booking_addition_preview:{ok:true,additional_cost_gbp:70}});
    const receipts=renterToolReceipts([{toolName:"lookup_pricing",toolCallId:"kit",result}]);
    expect(receipts).toContainEqual(expect.objectContaining({tool:"lookup_pricing",call_id:"kit:component-base:0",result:expect.objectContaining({listed_total_gbp:70})}));
    expect(receipts).toContainEqual(expect.objectContaining({tool:"quote_booking_addition",call_id:"kit:component-base:0:booking-preview"}));
    expect(renterToolReceipts([{toolName:"lookup_pricing",args:result}])).toEqual([]);
  });
  it("does not recover on a real thread, or accept another product or a failed lookup",async()=>{
    let lookups=0;
    const kit={...pricing,component_base_offerings:[{listing_name:"Body",product_id:999}]};
    expect(await withBookingAdditionPreview(kit,{...scope,threadId:"real"},async()=>({ok:false}),async()=>{lookups++;return pricing;})).toEqual(kit);
    expect(lookups).toBe(0);
    const result:any=await withBookingAdditionPreview(kit,scope,async()=>({ok:false}),async()=>pricing);
    expect(result.component_base_offering_quotes).toEqual([]);
    const unavailable:any=await withBookingAdditionPreview(kit,scope,async()=>({ok:false}),async()=>{throw Error("offline");});
    expect(unavailable.component_base_offering_quotes).toEqual([]);
    expect(unavailable.booking_addition_preview.ok).toBe(false);
  });

});
