import { expect,it } from "vitest";
import { datePriceEvidence } from "./renter-date-price-evidence";
const quote=(days:number,end_date:string)=>({start_date:"2026-10-20",end_date,days,total_gbp:40*days,lines:[{name:"Sony FX3",qty:1,item_id:"camera",daily_price_gbp:40,effective_rate_gbp:40,line_total_gbp:40*days}]});
const receipt=()=>({tool:"quote_booking_dates",call_id:"native",result:{thread_id:"__probe__dates",ok:true,preview_only:true,source:"native_lab_date_proposal",before_context_key:"current",physical_identity_key:"native-physical-key",quote:quote(3,"2026-10-22"),base_quote:quote(2,"2026-10-21"),price_delta_gbp:40}});
it("preserves the complete Native basket and original quote context",()=>{
 const evidence=datePriceEvidence(receipt(),"__probe__dates");
 expect(evidence).toHaveLength(2);expect(evidence[0]).toMatchObject({total_gbp:120,date_proposal:{physical_identity_key:"native-physical-key",before_context_key:"current",base_total_gbp:80,from_end_date:"2026-10-21"}});
 expect(evidence[1]).toMatchObject({total_gbp:120,daily_rate_gbp:40,quantity:1,days:3});
});
it("rejects altered totals, base basket, date span, delta and thread",()=>{
 for(const mutate of [(r:ReturnType<typeof receipt>)=>r.result.quote.total_gbp=121,(r:ReturnType<typeof receipt>)=>r.result.base_quote.lines[0].qty=2,(r:ReturnType<typeof receipt>)=>r.result.quote.days=4,(r:ReturnType<typeof receipt>)=>r.result.price_delta_gbp=41,(r:ReturnType<typeof receipt>)=>r.call_id="",(r:ReturnType<typeof receipt>)=>r.result.thread_id="other"]){
  const r=receipt();mutate(r);expect(datePriceEvidence(r,"__probe__dates")).toEqual([]);
 }
});

import { unsupportedPriceClaims } from "../../convex/lib/price_claims";
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
