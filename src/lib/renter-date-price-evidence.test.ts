import { expect,it } from "vitest";
import { datePriceEvidence } from "./renter-date-price-evidence";
import { dateStockQuoteEvidence } from "./renter-date-stock-evidence";
const quote=(days:number,end_date:string)=>({start_date:"2026-10-20",end_date,days,total_gbp:40*days,lines:[{name:"Sony FX3",qty:1,product_id:1173001,item_id:"camera",daily_price_gbp:40,effective_rate_gbp:40,line_total_gbp:40*days}]});
const receipt=()=>({tool:"quote_booking_dates",call_id:"native",result:{thread_id:"__probe__dates",ok:true,preview_only:true,source:"native_lab_date_proposal",before_context_key:"current",physical_identity_key:JSON.stringify([["camera","Sony FX3",1]]),
 quote:quote(3,"2026-10-22"),base_quote:quote(2,"2026-10-21"),price_delta_gbp:40,
 stock_receipts:[{item_id:"camera",item_name:"Sony FX3",requested_units:1,start_date:"2026-10-20",end_date:"2026-10-22",available:true,free_units:1,owned:true,source:"shared_inventory_confirmed_rentals",checked_at:1790850651000}]}});
const travelAdjustedReceipt=()=>{
 const r=receipt();
 r.result.base_quote=Object.assign(quote(2,"2026-10-21"),{subtotal_gbp:80,travel_compensation_gbp:5,total_gbp:75});
 r.result.quote=Object.assign(quote(3,"2026-10-22"),{subtotal_gbp:120,travel_compensation_gbp:5,total_gbp:115});
 return r;
};
it("preserves the complete Native basket and original quote context",()=>{
 const evidence=datePriceEvidence(receipt(),"__probe__dates");
 expect(evidence).toHaveLength(2);expect(evidence[0]).toMatchObject({total_gbp:120,date_proposal:{physical_identity_key:JSON.stringify([["camera","Sony FX3",1]]),before_context_key:"current",base_total_gbp:80,from_end_date:"2026-10-21"}});
 expect(evidence[1]).toMatchObject({total_gbp:120,daily_rate_gbp:40,quantity:1,days:3});
});
it("projects a verified date quote into the same physical-stock and billable-price scopes",()=>{
 const native=receipt(),quote=dateStockQuoteEvidence(native,"__probe__dates");
 expect(quote).toMatchObject({start_date:"2026-10-20",end_date:"2026-10-22",proposed_basket:true,
  listing_quote:{total_gbp:120,lines:[{product_id:1173001,name:"Sony FX3",quantity:1,total_gbp:120}]},
  items:[{item_id:"camera",name:"Sony FX3",quantity:1}]});
 if(!quote)return;
 const current={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"Sony FX3",quantity:1}]};
 const stockRequest=stockRequestForInquiryQuote(current,[quote]);
 const priceRequest=priceRequestForInquiryQuote(current,[quote]);
 const stock=stockReceipts(renterToolReceipts([{payload:{toolName:"quote_booking_dates",toolCallId:"native",result:native.result}}])).map(r=>({
  item:String(r.result.item_name),start_date:String(r.result.start_date),end_date:String(r.result.end_date),quantity:Number(r.result.requested_units),
  available:r.result.available as boolean|null,free_units:r.result.free_units as number|null,checked_at:Number(r.result.checked_at),call_id:r.call_id,
  owned:r.result.owned===true,basket:r.result.basket as {available:boolean|null;items:Array<{name:string;quantity:number}>}|undefined,
 }));
 expect(stockRequest).toMatchObject({start_date:"2026-10-20",end_date:"2026-10-22",items:[{name:"Sony FX3",quantity:1}]});
 expect(priceRequest).toEqual({start_date:"2026-10-20",end_date:"2026-10-22",items:[{name:"Sony FX3",quantity:1}]});
 const verifiedRequest=stockRequestWithVerifiedQuoteItems(stockRequest,[quote!],stock);
 expect(verifiedRequest.items).toEqual([{name:"Sony FX3",quantity:1,complete:true,components:[{name:"Sony FX3",quantity:1}]}]);
 expect(unsupportedStockClaims("The Sony FX3 is available for your dates.",stock,verifiedRequest)).toEqual([]);
 expect(unsupportedStockClaims("The Sony FX3 is available for your dates.",stock,current)).not.toEqual([]);
 expect(unsupportedPriceClaims("The Sony FX3 rental total for 20–22 October is £120.",datePriceEvidence(native,"__probe__dates"),priceRequest)).toEqual([]);
 expect(unsupportedPriceClaims("The Sony FX3 rental total for 20–23 October is £120.",datePriceEvidence(native,"__probe__dates"),current)).not.toEqual([]);
});
it("fails closed if a date proposal omits, conflicts with, or lacks positive stock receipts",()=>{
 const mutations=[
  (r:ReturnType<typeof receipt>)=>{r.result.stock_receipts=[];},
  (r:ReturnType<typeof receipt>)=>{r.result.stock_receipts[0].available=false;},
  (r:ReturnType<typeof receipt>)=>{r.result.stock_receipts[0].end_date="2026-10-21";},
  (r:ReturnType<typeof receipt>)=>{r.result.physical_identity_key="wrong-identity";},
 ];
 for(const mutate of mutations){const r=receipt();mutate(r);expect(dateStockQuoteEvidence(r,"__probe__dates")).toBeNull();}
});
it("rejects altered totals, base basket, date span, delta and thread",()=>{
 for(const mutate of [(r:ReturnType<typeof receipt>)=>r.result.quote.total_gbp=121,(r:ReturnType<typeof receipt>)=>r.result.base_quote.lines[0].qty=2,(r:ReturnType<typeof receipt>)=>r.result.quote.days=4,(r:ReturnType<typeof receipt>)=>r.result.price_delta_gbp=41,(r:ReturnType<typeof receipt>)=>r.call_id="",(r:ReturnType<typeof receipt>)=>r.result.thread_id="other"]){
  const r=receipt();mutate(r);expect(datePriceEvidence(r,"__probe__dates")).toEqual([]);
 }
});

import { unsupportedPriceClaims } from "../../convex/lib/price_claims";
import { dateProposalEvidenceValidator } from "../../convex/lib/renter_date_proposal";
import { draftEvidenceValidator } from "../../convex/lib/renter_draft_evidence";
import {renterToolReceipts,stockReceipts} from "./renter-tool-evidence";
import {priceRequestForInquiryQuote,stockRequestForInquiryQuote,stockRequestWithVerifiedQuoteItems,unsupportedStockClaims} from "../../convex/lib/stock_claims";
it("grounds a Native extension delta without confusing it with the full total",()=>{
 const evidence=datePriceEvidence(receipt(),"__probe__dates");
 const request={items:[{name:"Sony FX3",quantity:1}],start_date:"2026-10-20",end_date:"2026-10-21"};
 expect(unsupportedPriceClaims("Extending to 20–22 October costs £40 extra.",evidence,request)).toEqual([]);
 expect(unsupportedPriceClaims("Extending to 20–22 October costs £41 extra.",evidence,request)).not.toEqual([]);
 expect(unsupportedPriceClaims("Your booking total for 20–22 October is £40.",evidence,request)).not.toEqual([]);
 expect(unsupportedPriceClaims("Extending to 20–23 October costs £40 extra.",evidence,request)).not.toEqual([]);
 expect(unsupportedPriceClaims("Extending to 20–22 October costs £40 extra.",evidence,{...request,items:[{name:"Sony A7 III",quantity:1}]})).not.toEqual([]);
});

import nativeQuote from "./fixtures/renter-date-native-quote.json";
it("uses raw Native tiers rather than multiplying an approximate displayed daily rate",()=>{
 const evidence=datePriceEvidence({tool:"quote_booking_dates",call_id:"actual-native",result:nativeQuote},nativeQuote.thread_id);
 expect(evidence[0]).toMatchObject({total_gbp:170});expect(evidence[1]).toMatchObject({daily_rate_gbp:56.67,total_gbp:170});
 const wrong=structuredClone(nativeQuote);wrong.quote.lines[0].line_total_gbp=170.01;wrong.quote.total_gbp=170.01;wrong.price_delta_gbp=46.01;
 expect(datePriceEvidence({tool:"quote_booking_dates",call_id:"actual-native",result:wrong},nativeQuote.thread_id)).toEqual([]);
});

it("never promotes an extension difference into a verified deposit or delivery fee",()=>{
 const evidence=datePriceEvidence(receipt(),"__probe__dates");
 const request={items:[{name:"Sony FX3",quantity:1}],start_date:"2026-10-20",end_date:"2026-10-21"};
 for(const fee of ["deposit","delivery","replacement cost"])expect(unsupportedPriceClaims(`Extending to 20–22 October requires £40 extra ${fee}.`,evidence,request)).not.toEqual([]);
});

it("grounds date-change totals net of the already accepted travel adjustment",()=>{
 const evidence=datePriceEvidence(travelAdjustedReceipt(),"__probe__dates");
 expect(evidence[0]).toMatchObject({total_gbp:115,date_proposal:{base_total_gbp:75,base_travel_compensation_gbp:5,travel_compensation_gbp:5}});
 expect(dateProposalEvidenceValidator.fields).toHaveProperty("base_travel_compensation_gbp");
 expect(dateProposalEvidenceValidator.fields).toHaveProperty("travel_compensation_gbp");
 expect(dateProposalEvidenceValidator.fields.base_travel_compensation_gbp.isOptional).toBe("optional");
 const request={items:[{name:"Sony FX3",quantity:1}],start_date:"2026-10-20",end_date:"2026-10-21"};
 const text="Extending your booking to 20–22 October would cost £40 extra, bringing your booking total to £115, including your existing £5 travel adjustment.";
 expect(unsupportedPriceClaims(text,evidence,request)).toEqual([]);
 expect(unsupportedPriceClaims(text.replace("£115","£116"),evidence,request)).not.toEqual([]);
 expect(unsupportedPriceClaims(text.replace("£5","£6"),evidence,request)).not.toEqual([]);
 expect(unsupportedPriceClaims(text.replace("your existing ",""),evidence,request)).not.toEqual([]);
});

it("uses the shared date-proposal validator at the persisted draft-evidence boundary",()=>{
 const prices=draftEvidenceValidator.fields.prices as unknown as {element?:{fields?:Record<string,unknown>}};
 const persistedProposal=prices.element?.fields?.date_proposal as {fields?:Record<string,unknown>}|undefined;
 expect(Object.keys(persistedProposal?.fields??{}).sort()).toEqual(Object.keys(dateProposalEvidenceValidator.fields).sort());
});

it("rejects a date quote whose net total does not reconcile to listed lines and the adjustment",()=>{
 const r=travelAdjustedReceipt();r.result.quote.total_gbp=116;r.result.price_delta_gbp=41;
 expect(datePriceEvidence(r,"__probe__dates")).toEqual([]);
});

it("grounds a conditional extension's extra cost and full total in the same sentence",()=>{
 const evidence=datePriceEvidence(receipt(),"__probe__dates"),request={items:[{name:"Sony FX3",quantity:1}],start_date:"2026-10-20",end_date:"2026-10-21"};
 const text="Extending your booking to 20–22 October would cost £40 extra, bringing your booking total to £120.";
 expect(unsupportedPriceClaims(text,evidence,request)).toEqual([]);
 for(const wrong of [text.replace("£120","£40"),text.replace("£40","£120"),text.replace("22 October","23 October")])expect(unsupportedPriceClaims(wrong,evidence,request)).not.toEqual([]);
});

it("does not carry an extension period into an unrelated sentence or ignore explicit wrong duration",()=>{
 const evidence=datePriceEvidence(receipt(),"__probe__dates"),request={items:[{name:"Sony FX3",quantity:1}],start_date:"2026-10-20",end_date:"2026-10-21"};
 expect(unsupportedPriceClaims("Extending to 20–22 October would cost £40 extra, bringing your booking total for 2 days to £120.",evidence,request)).not.toEqual([]);
 expect(unsupportedPriceClaims("Extending to 20–22 October would cost £40 extra. Your current booking total is £120.",evidence,request)).not.toEqual([]);
});
