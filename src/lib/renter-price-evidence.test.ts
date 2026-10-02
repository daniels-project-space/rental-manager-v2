import {describe,it,expect} from "vitest";
import {renterPriceEvidence} from "./renter-price-evidence";
import type {ToolReceipt} from "./renter-tool-evidence";
import {unsupportedPriceClaims} from "../../convex/lib/price_claims";
const receipt=(tool:string,result:Record<string,unknown>,call_id="call"):ToolReceipt=>({tool,result,call_id});
describe("server price receipt adapters",()=>{
 it("binds an exact quote's short name only to the verified account and listing",()=>{
  const listing="Sony A7 ii mirrorless Camera full frame digital cinema + 28-70mm Zoom FE Sony lens + 128gb sd card Sony a7ii";
  const native={found:true,matched_listing:listing,product_id:1172846,account_slug:"leo",days:2,quantity:1,daily_rate_gbp:28,listed_total_gbp:56,source:"hygglo_tier"};
  const identities=[{account_slug:"leo",product_id:1172846,names:["Sony A7 II",listing]}];
  const request={items:[{name:"Sony A7 II",quantity:1}]};
  const claim="Yes, the Sony A7 II kit is available for the 6th to the 7th of October. For the 2 days, the total comes to £56.";
  expect(unsupportedPriceClaims(claim,renterPriceEvidence([receipt("lookup_pricing",native)],identities),request)).toEqual([]);
  const evidence=renterPriceEvidence([receipt("lookup_pricing",native)],identities);
  const durationFirst="Yes, the Sony A7 II kit is available from the 6th to the 7th of October. For 2 days, the total is £56.";
  expect(unsupportedPriceClaims(durationFirst,evidence,request)).toEqual([]);
  expect(unsupportedPriceClaims(durationFirst.replace("For 2 days","For 4 days"),evidence,request)).not.toEqual([]);
  expect(unsupportedPriceClaims(durationFirst.replace("For 2 days","For the Pyxis"),evidence,request)).not.toEqual([]);
  for(const changed of [{...native,product_id:1172847},{...native,account_slug:"diogo"},{...native,account_slug:undefined}]){
   const proof=renterPriceEvidence([receipt("lookup_pricing",changed)],identities);
   expect(proof[0].names).not.toContain("Sony A7 II");
   expect(unsupportedPriceClaims(claim,proof,request)).not.toEqual([]);
  }
 });
 it("keeps exact alternative duration, quantity and base separate",()=>{
  const result=renterPriceEvidence([receipt("find_owned_alternatives",{alternatives:[{name:"BMPCC 6K Pro",daily_price_gbp:35,quote:{days:3,quantity:2,daily_rate_gbp:30,listed_total_gbp:180,source:"hygglo_tier",start_date:"2026-10-02",end_date:"2026-10-04"}}]})]);
  expect(result[0]).toMatchObject({names:["BMPCC 6K Pro"],days:3,quantity:2,daily_rate_gbp:30,base_rate_gbp:35,total_gbp:180,start_date:"2026-10-02"});
 });
 it("does not treat arbitrary numeric keys or failed results as rental evidence",()=>{
  expect(renterPriceEvidence([receipt("knowledge_search",{daily_price:99,total_gbp:99}),receipt("lookup_pricing",{found:false,matched_listing:"FX3",days:1,quantity:1,daily_rate_gbp:99}),receipt("find_owned_alternatives",{alternatives:[{name:"Unknown",daily_price_gbp:99,price_requires_owner_confirmation:true}]})])).toEqual([]);
 });
 it("does not treat the model's echoed item_name as verified identity",()=>{
  expect(renterPriceEvidence([receipt("lookup_pricing",{found:true,item_name:"Pyxis",days:1,quantity:1,daily_rate_gbp:40,listed_total_gbp:40})])).toEqual([]);
 });
 it("keeps an unverified multi-day catalog rate as base-only evidence",()=>{
  const got=renterPriceEvidence([receipt("lookup_pricing",{found:true,matched_canonical:"Sony FX3",days:3,quantity:1,daily_rate_gbp:40,listed_total_gbp:null,source:"curated_catalog",multi_day_basis:"unknown_no_listing"})]);
  expect(got[0]).toMatchObject({base_rate_gbp:40});expect(got[0].daily_rate_gbp).toBeUndefined();expect(got[0].total_gbp).toBeUndefined();
 });
 it("retains only the latest authoritative Lab order after a modification",()=>{
  const old=receipt("get_lab_order",{days:3,lines:[{name:"FX3",qty:1,effective_rate_gbp:30,line_total_gbp:90}],total_gbp:90},"before");
  const next=receipt("get_lab_order",{days:4,lines:[{name:"FX3",qty:2,effective_rate_gbp:30,line_total_gbp:240}],total_gbp:240},"after");
  const got=renterPriceEvidence([old,next]);expect(got).toHaveLength(2);expect(got.every(g=>g.days===4)).toBe(true);expect(got.find(g=>g.kind==="basket")?.total_gbp).toBe(240);
 });
});

it("binds a complete read-only proposal to its thread, base basket, addition, dates and conditional claim",()=>{
 const base=[{name:"Sony A7 II",quantity:1}], added=[{name:"Sony 28-70mm",quantity:1}];
 const quote={days:2,start_date:"2026-10-06",end_date:"2026-10-07",lines:[{name:"Sony A7 II",qty:1,line_total_gbp:56},{name:"Sony 28-70mm",qty:1,line_total_gbp:36}],total_gbp:92};
 const native={ok:true,preview_only:true,source:"native_lab_proposal",thread_id:"__probe__quote",base_items:base,added_items:added,quote};
 const scope={items:base,start_date:quote.start_date,end_date:quote.end_date};
 const proof=renterPriceEvidence([receipt("quote_booking_addition",native)],[],native.thread_id);
 const claim="One extra Sony 28-70mm would bring your booking total to £92.";
 expect(unsupportedPriceClaims(claim,proof,scope)).toEqual([]);
 const baseProof={...proof[0],proposal:undefined,items:base,total_gbp:56};
 const fromTo="One extra Sony 28-70mm would bring your booking total from £56 to £92.";
 expect(unsupportedPriceClaims(fromTo,[baseProof,...proof],scope)).toEqual([]);
 expect(unsupportedPriceClaims(fromTo,[baseProof],scope)).toHaveLength(1);
 expect(unsupportedPriceClaims(fromTo.replace("£56","£55"),[baseProof,...proof],scope)).toHaveLength(1);

 const unchanged={...proof[0],proposal:undefined,items:base,total_gbp:56};
 expect(unsupportedPriceClaims(claim.replace("£92","£56"),[unchanged],scope)).toHaveLength(1);

 const nativeLens={found:true,matched_canonical:"Sony 28-70mm",days:2,quantity:1,daily_rate_gbp:18,listed_total_gbp:36,source:"hygglo_tier",start_date:quote.start_date,end_date:quote.end_date};
 const actual="An extra Sony 28-70mm lens would cost £36 for the 2 days (6 to 7 October). Adding it would bring your complete booking total to £92.";
 const fullProof=[...proof,...renterPriceEvidence([receipt("lookup_pricing",nativeLens)])];
 expect(unsupportedPriceClaims(actual,fullProof,scope)).toEqual([]);
 const declined="Adding that 1 extra Sony 28-70mm lens would bring the total to £92 for the 2 days.";
 expect(unsupportedPriceClaims(declined,proof,scope)).toEqual([]);
 expect(unsupportedPriceClaims(declined,[{...proof[0],proposal:undefined,items:base,total_gbp:56}],scope)).toHaveLength(1);
 expect(unsupportedPriceClaims(declined.replace("£92","£56"),[{...proof[0],proposal:undefined,items:base,total_gbp:56}],scope)).toHaveLength(1);

 expect(unsupportedPriceClaims(actual.replace("would bring","brings"),fullProof,scope)).toHaveLength(1);

 for(const text of [claim.replace("would bring","brings"),claim.replace("One extra","Two extra"),claim.replace("Sony 28-70mm","Sony GM 24-70mm"),claim.replace("£92","£100")])expect(unsupportedPriceClaims(text,proof,scope),text).toHaveLength(1);
 expect(unsupportedPriceClaims(claim,proof,{...scope,items:[{name:"Sony A7 III",quantity:1}]})).toHaveLength(1);
 expect(unsupportedPriceClaims(claim,proof,{...scope,end_date:"2026-10-08"})).toHaveLength(1);
 expect(renterPriceEvidence([receipt("quote_booking_addition",native)],[],"__probe__other")).toEqual([]);
 expect(renterPriceEvidence([receipt("quote_booking_addition",{...native,ok:false})],[],native.thread_id)).toEqual([]);
 expect(renterPriceEvidence([receipt("quote_booking_addition",{...native,quote:{...quote,lines:[quote.lines[0],{...quote.lines[1],line_total_gbp:null}]}})],[],native.thread_id)).toEqual([]);
});
