import {describe,it,expect} from "vitest";
import {minimumRentalContext,minimumRentalPrompt,requestedBasketEvidence} from "./minimum_rental";
import {RENTAL_STAGES} from "./rental_stage";
import {guardDraft} from "./draft_guard";
import type {PriceEvidence} from "./price_claims";
import type {StockRequest} from "./stock_claims";
const request:StockRequest={start_date:"2026-10-02",end_date:"2026-10-03",items:[{name:"Sony FX3",quantity:2}]};
const price:PriceEvidence={names:["Sony FX3"],kind:"rental",days:2,quantity:2,daily_rate_gbp:15,total_gbp:60,source:"hygglo_tier",call_id:"native"};
const context=(prices=[price],req=request,stage="INQUIRY")=>minimumRentalContext(stage,40,prices,req);
describe("prospective minimum-value context",()=>{
 it("uses inclusive dates and exact quantity/tier total",()=>{
  expect(context()).toMatchObject({status:"meets",total_gbp:60,basis:"complete_requested_quote"});
  expect(context([{...price,quantity:1,total_gbp:30}],{...request,items:[{name:"Sony FX3",quantity:1}]})).toMatchObject({status:"below",total_gbp:30});
 });
 it("evaluates selected inquiry alternatives separately from the original request",()=>{
  const offer:PriceEvidence={names:[],items:[{name:"Sony 28-70mm",quantity:1}],kind:"basket",days:2,start_date:request.start_date!,end_date:request.end_date!,total_gbp:36,source:"native_inquiry_basket",quote_role:"inquiry",call_id:"native-selected"};
  const old:PriceEvidence={...offer,items:request.items,total_gbp:90,source:"lab_order_quote",quote_role:undefined};
  const expensive={...offer,total_gbp:124,call_id:"other-option"};
  for(const selected of [[offer],[offer,expensive],[expensive,offer]])expect(minimumRentalContext("INQUIRY",40,[old],request,selected)).toMatchObject({status:"below",total_gbp:36,basis:"lowest_selected_inquiry_quote"});
  expect(minimumRentalContext("INQUIRY",40,[old],request,[expensive])).toMatchObject({status:"meets",total_gbp:124});
  expect(minimumRentalContext("CONFIRMED_UPCOMING",40,[old],request,[offer]).status).toBe("not_applicable");
  for(const bad of [{...offer,source:"lab_order_quote"},{...offer,end_date:undefined},{...offer,call_id:""},{...offer,items:[]}])expect(minimumRentalContext("INQUIRY",40,[old],request,[bad]).status).toBe("unknown");
 });
 it("keeps prospective instructions scoped to the evaluated quote",()=>{
  for(const assessed of [context(),context([{...price,total_gbp:30}]),context([])])expect(minimumRentalPrompt(assessed)).toContain("supersedes the earlier request's assessment");
  expect(minimumRentalPrompt(context([price],request,"CONFIRMED_UPCOMING"))).not.toContain("supersedes");
  expect(minimumRentalPrompt(context([price],request,"COMPLETED"))).toContain("supersedes");
 });
 it("assesses the new selected inquiry rather than reopening a closed rental's price",()=>{
  const quote:PriceEvidence={names:[],items:[{name:"TTArtisan 11mm",quantity:1}],kind:"basket",days:1,start_date:"2026-10-22",end_date:"2026-10-22",total_gbp:21,source:"native_inquiry_basket",quote_role:"inquiry",call_id:"selected-new-inquiry"};
  for(const stage of ["COMPLETED","CANCELLED","VERIFICATION_FAILED"]) {
   expect(minimumRentalContext(stage,40,[price],request)).toMatchObject({stage,status:"not_applicable",basis:"none"});
   const assessed=minimumRentalContext(stage,40,[price],request,[quote]);
   expect(assessed).toMatchObject({stage:"INQUIRY",status:"below",total_gbp:21,basis:"lowest_selected_inquiry_quote"});
   expect(minimumRentalPrompt(assessed)).toContain("optional");expect(minimumRentalPrompt(assessed)).not.toContain("£40");
   expect(minimumRentalContext(stage,40,[price],request,[{...quote,total_gbp:60}])).toMatchObject({stage:"INQUIRY",status:"meets",total_gbp:60});
   expect(minimumRentalContext(stage,40,[price],request,[{...quote,end_date:undefined}])).toMatchObject({status:"unknown",total_gbp:null});
  }
  expect(minimumRentalContext("IN_USE",40,[price],request,[quote]).status).toBe("not_applicable");
  expect(guardDraft("It is available for your new dates.",{history:[],lastRenterMessage:"Can I rent it again?",commercialContext:minimumRentalContext("COMPLETED",40,[price],request,[quote])}).flags.some(f=>f.type==="LOW_VALUE_BLOCK")).toBe(true);
 });
 it("does not classify partial baskets, unknown dates or mismatched scope",()=>{
  const mixed={...request,items:[...request.items,{name:"Sony A7 V",quantity:1}]};
  for(const [p,r] of [[[price],mixed],[[price],{...request,end_date:undefined}],[[{...price,quantity:1}],request],[[{...price,start_date:"2026-10-04"}],request]] as Array<[PriceEvidence[],StockRequest]>)expect(context(p,r).status).toBe("unknown");
 });
 it("requires independently attributed quote data",()=>{
  expect(context([{...price,call_id:""}]).status).toBe("unknown");
  expect(context([{...price,source:""}]).status).toBe("unknown");
 });
 it("does not treat alternative prices as missing requested gear",()=>{
  expect(context([{...price,names:["Sony A7 V"]}]).status).toBe("unknown");
  expect(context([price,{...price,total_gbp:70}]).status).toBe("unknown");
 });
 it.each(RENTAL_STAGES)("applies policy only before acceptance: %s",stage=>{
  const got=context([{...price,total_gbp:30}],request,stage);
  expect(got.status).toBe(["INQUIRY","AWAITING_OWNER_APPROVAL"].includes(stage)?"below":"not_applicable");
 });
 it("preserves an authoritative current booking amount over catalogue estimates",()=>{
  const basket:PriceEvidence={names:[],items:request.items,kind:"basket",days:2,total_gbp:35,source:"booking_gross_amount",call_id:"booking"};
  expect(context([price,basket])).toMatchObject({status:"below",total_gbp:35,basis:"current_booking"});
 });
 it("does not manufacture a basket receipt from a partial request",()=>{
  const mixed={...request,items:[...request.items,{name:"Sony A7 V",quantity:1}]};
  expect(requestedBasketEvidence([price],mixed)).toEqual([]);
  const receipt=requestedBasketEvidence([price],request);expect(receipt[0]).toMatchObject({total_gbp:60,items:request.items,days:2,source:"complete_requested_quote"});
  const guard=guardDraft("The combined total is £60 for 2 days.",{history:[],lastRenterMessage:"Total?",hasItemGrounding:true,priceRequest:request,priceEvidence:[price,...receipt]});
  expect(guard.flags.filter(f=>f.type==="PRICE_HALLUCINATION")).toEqual([]);
 });
 it("allows zero to disable the policy and omits private threshold from model instructions",()=>{
  expect(minimumRentalContext("INQUIRY",0,[price],request).status).toBe("disabled");
  const below=context([{...price,total_gbp:30}]);expect(minimumRentalPrompt(below)).not.toContain("£40");
  expect(minimumRentalPrompt(context([],request))).not.toContain("likely a small");
 });
 it("wires the prospective nudge and prevents threshold disclosure without reopening later stages",()=>{
  const opts={history:[],lastRenterMessage:"Available?",hasItemGrounding:true,commercialContext:context([{...price,total_gbp:30}])};
  expect(guardDraft("It is available for those dates.",opts).flags.some(f=>f.type==="LOW_VALUE_BLOCK")).toBe(true);
  expect(guardDraft("It isn't available for those dates.",opts).flags.some(f=>f.type==="LOW_VALUE_BLOCK")).toBe(false);
  expect(guardDraft("The minimum rental value is £40.",opts).flags).toContainEqual(expect.objectContaining({type:"MINIMUM_POLICY_DISCLOSURE",severity:"critical"}));
  expect(guardDraft("There is a £40 booking minimum.",opts).flags.some(f=>f.type==="MINIMUM_POLICY_DISCLOSURE")).toBe(true);
  expect(guardDraft("Minimum focus distance is 30cm, and the kit is £60.",opts).flags.some(f=>f.type==="MINIMUM_POLICY_DISCLOSURE")).toBe(false);
  expect(guardDraft("It is available for those dates.",{...opts,commercialContext:context([price],request,"CONFIRMED_UPCOMING")}).flags.some(f=>f.type==="LOW_VALUE_BLOCK")).toBe(false);
 });
 it("keeps the relevant shoot-question fallback required by the Native commercial guidance",()=>{
  const question="It is available for those dates. What kind of project are you shooting?";
  const opts={history:[],lastRenterMessage:"Is it available and what does it cost?",hasItemGrounding:true,commercialContext:context([{...price,total_gbp:30}])};
  const reviewed=guardDraft(question,opts);
  expect(reviewed.text).toContain("What kind of project");
  expect(reviewed.flags.filter(f=>["LOW_VALUE_BLOCK","QUALIFY_QUESTION_SPAM"].includes(f.type))).toEqual([]);
  expect(guardDraft("It is available. Do you need anything else?",opts).flags.some(f=>f.type==="LOW_VALUE_BLOCK")).toBe(true);
  expect(guardDraft(question,{...opts,commercialContext:context([price],request,"IN_USE")}).flags.some(f=>f.type==="QUALIFY_QUESTION_SPAM")).toBe(true);
 });
 it("uses authoritative completion for receipt acknowledgements but never for invented inspection",()=>{
  const opts={history:[],lastRenterMessage:"Everything returned, thanks."};
  const acknowledgement="Thanks for bringing everything back!";
  expect(guardDraft(acknowledgement,{...opts,stage:"IN_USE"}).flags.some(f=>f.type==="GEAR_RECEIPT_CONFIRMED")).toBe(true);
  expect(guardDraft(acknowledgement,{...opts,stage:"COMPLETED"}).flags.some(f=>f.type==="GEAR_RECEIPT_CONFIRMED")).toBe(false);
  expect(guardDraft("All good on the return.",{...opts,stage:"COMPLETED"}).flags.some(f=>f.type==="GEAR_RECEIPT_CONFIRMED")).toBe(true);
 });
});
