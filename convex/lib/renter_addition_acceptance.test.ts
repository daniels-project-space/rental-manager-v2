import { describe, expect, it } from "vitest";
import { acceptsAddition, directItemSelection, type AdditionAcceptanceQuote } from "./renter_addition_acceptance";
import { acceptsCompleteBasketOffer } from "./renter_complete_basket_acceptance";
import type { SentAdditionProposal } from "./renter_sent_proposal";
const quote=():AdditionAcceptanceQuote=>({context_key:"base",start_date:"2026-10-20",end_date:"2026-10-21",total_gbp:194,additional_cost_gbp:70,lines:[{product_id:2,name:"Blazar Remus 100mm",qty:1,line_total_gbp:50},{product_id:3,name:"PL to L mount",qty:1,line_total_gbp:20}]});
const owner=()=>({body_text:"The Blazar Remus 100mm lens and PL to L mount adapter cost £70 extra for 20–21 October, bringing the booking total to £194. Shall I add both?",quoted_additions:[{context_key:"base",epoch:82,quoted_for_message_id:"previous",items:[{product_id:2,qty:1},{product_id:3,qty:1}],base_items:[{name:"BMPCC 6K Full Frame",quantity:1}],added_items:[{name:"Blazar Remus 100mm",quantity:1},{name:"PL to L mount",quantity:1}],start_date:"2026-10-20",end_date:"2026-10-21",total_gbp:194,additional_cost_gbp:70} satisfies SentAdditionProposal]});
const sonyLensQuote=():AdditionAcceptanceQuote=>({context_key:"sony-fx3",start_date:"2026-12-11",end_date:"2026-12-11",total_gbp:70,additional_cost_gbp:19,lines:[{product_id:1172504,name:"Sony 28-70mm",qty:1,line_total_gbp:19,aliases:["Sony FE 28-70mm f/3.5-5.6 OSS"]}]});
const sonyLensOwner=()=>({body_text:"The Sony 28-70mm lens is £19 extra, bringing the total to £70. Would you like me to add it?",quoted_additions:[{context_key:"sony-fx3",epoch:1,quoted_for_message_id:"owner-1",items:[{product_id:1172504,qty:1}],base_items:[{name:"Sony FX3",quantity:1}],added_items:[{name:"Sony 28-70mm",quantity:1,aliases:["Sony FE 28-70mm f/3.5-5.6 OSS"]}],start_date:"2026-12-11",end_date:"2026-12-11",total_gbp:70,additional_cost_gbp:19} satisfies SentAdditionProposal]});
it("parses a named addition directed to the renter's existing item request",()=>{
 expect(directItemSelection("Yes, please add the Sony 28-70mm lens to my FX3 request.",sonyLensQuote().lines)).toMatchObject({named:true,matches:true,items:[{product_id:1172504,qty:1}]});
 expect(acceptsAddition("Yes, please add the Sony 28-70mm lens to my FX3 request.",sonyLensQuote(),sonyLensOwner())).toBe(true);
});
it("accepts a natural addition after the owner itemised the complete updated basket",()=>{
 const text="Yes, absolutely! The Sony 28-70mm uses the native Sony E-mount, so it mounts straight onto the FX3 with no adapter needed.\n\nFor 1 day (11 December 2026):\n- 1 × Sony FX3: £51\n- 1 × Sony 28-70mm: £19\nTotal: £70\n\nLet me know if you would like me to update the request with the lens included!";
 const quote={...sonyLensQuote(),base_lines:[{product_id:1097510,name:"Sony FX3",qty:1,line_total_gbp:51}]};
 expect(acceptsAddition("Yes, please add the Sony 28-70mm lens to my FX3 request.",quote,{...sonyLensOwner(),body_text:text})).toBe(true);
 expect(acceptsAddition("Yes, please add the Sony 28-70mm lens to my FX3 request.",sonyLensQuote(),{...sonyLensOwner(),body_text:text})).toBe(false);
});
it("accepts both quoted items when directed to the existing request",()=>{
 expect(acceptsAddition("Yes, please add both to my Blackmagic request.",quote(),owner())).toBe(true);
});
it("does not turn a conditional request suffix into agreement",()=>{
 expect(acceptsAddition("Yes, please add the Sony 28-70mm lens to my FX3 request only if it is £15.",sonyLensQuote(),sonyLensOwner())).toBe(false);
});
describe("exact addition agreement",()=>{
 for(const text of ["Please add the Blazar Remus 100mm and your PL to L mount adapter for £70 extra.","Please add the Blazar Remus 100mm lens and the PL to L adapter for 20 to 21 October at £70 extra.","Add one Blazar Remus 100mm and one PL to L mount for £70 extra.","I would like to add the Blazar Remus 100mm and PL to L mount for £70 extra."]){
  it(`accepts a complete named priced instruction: ${text}`,()=>expect(acceptsAddition(text,quote())).toBe(true));
 }
 for(const text of ["How heavy is the Blackmagic 6K Full Frame camera?","Can you tell me the pickup address?","Please quote the Blazar Remus 100mm and adapter.","Please add the Sony FX3 for £70 extra.","Please add the Blazar Remus 100mm for £70 extra.","Please add two Blazar Remus 100mm and your PL to L mount for £70 extra.","Please add the Blazar Remus 100mm and PL to L mount for £60 extra.","Please add the Blazar Remus 100mm and PL to L mount for £194 extra.","Please add the Blazar Remus 100mm and PL to L mount for 22 to 23 October at £70 extra.","Please add the Blazar Remus 100mm and PL to L mount tomorrow for £70 extra.","If it costs £70 extra please add the Blazar Remus 100mm and PL to L mount.",'What does "please add the Blazar Remus 100mm and PL to L mount for £70 extra" mean?',"My friend said please add the Blazar Remus 100mm and PL to L mount for £70 extra.","Please add the Blazar Remus 100mm at £50 and the PL to L mount at £50.","Please add the Blazar Remus 100mm or PL to L mount for £70 extra."]){
  it(`refuses conflicting or absent agreement: ${text}`,()=>expect(acceptsAddition(text,quote(),owner())).toBe(false));
 }
 for(const text of ["Yes, please add both.","Yes please.","Go ahead.","Please add them.","Please add the Blazar Remus 100mm and PL to L mount as quoted."]){
  it(`accepts the actual unchanged offered quote: ${text}`,()=>expect(acceptsAddition(text,quote(),owner())).toBe(true));
 }
 for(const text of ["Yes, please add both after I confirm.","Yes, please add both if the adapter is free.","Yes?","Yes, how heavy is the camera?","Go ahead with the Sony FX3.","Please add two of both.","Yes, please add both for £60 extra.","Yes, please add both for 22 to 23 October."]){
  it(`does not treat uncertain or different acceptance as permission: ${text}`,()=>expect(acceptsAddition(text,quote(),owner())).toBe(false));
 }
 for(const variant of ["no_archive","changed_price","changed_total","changed_context","changed_dates","changed_qty","wrong_items","unused_quote","alternative_offer","multiple_offers"]){
  it(`does not accept ${variant}`,()=>{
   const o=owner();const p=o.quoted_additions[0];
   if(variant==="no_archive")o.quoted_additions=[];
   if(variant==="changed_price")p.additional_cost_gbp=60;
   if(variant==="changed_total")p.total_gbp=184;
   if(variant==="changed_context")p.context_key="another-basket";
   if(variant==="changed_dates")p.end_date="2026-10-22";
   if(variant==="changed_qty")p.items[0].qty=2;
   if(variant==="wrong_items")p.items[0].product_id=4;
   if(variant==="unused_quote")o.body_text="The camera weighs about a kilogram.";
   if(variant==="alternative_offer")o.body_text="The Blazar Remus 100mm and PL to L mount cost £70 extra, or choose another lens.";
   if(variant==="multiple_offers")o.quoted_additions.push({...p,items:[{product_id:4,qty:1}]});
   expect(acceptsAddition("Yes please.",quote(),o)).toBe(false);
  });
 }
 it("does not silently substitute a commercial camera-and-lens kit for a camera-only request",()=>{
  const q=quote();q.lines=[{product_id:4,name:"Sony FX3 + Sony 28-70mm",qty:1,line_total_gbp:120}];q.additional_cost_gbp=120;q.total_gbp=244;
  expect(acceptsAddition("Please add the Sony FX3 at £120 extra.",q)).toBe(false);
  expect(acceptsAddition("Please add the Sony FX3 + Sony 28-70mm at £120 extra.",q)).toBe(true);
 });
 it("accepts a quote that distinguishes the current booking from the proposed total",()=>{
  const o=owner();o.body_text="Your current booking is £124. The Blazar Remus 100mm is £50 and the PL to L mount is £20. The addition is £70 extra and the booking total is £194. Shall I add both?";
  expect(acceptsAddition("Yes please.",quote(),o)).toBe(true);
 });
 it("does not treat a single component price as agreement to the complete setup",()=>{
  expect(acceptsAddition("Please add the Blazar Remus 100mm and PL to L mount. The Blazar Remus 100mm is £50.",quote())).toBe(false);
 });
 it("accepts matching itemised Native prices",()=>{
  expect(acceptsAddition("Please add the Blazar Remus 100mm at £50 and the PL to L mount at £20.",quote())).toBe(true);
  expect(acceptsAddition("Please add the PL to L mount at £20 and the Blazar Remus 100mm at £50.",quote())).toBe(true);
 });
 it("does not let a generic adapter request authorise a chosen mount",()=>{
  const q=quote();q.lines=q.lines.slice(1);q.additional_cost_gbp=20;q.total_gbp=144;
  expect(acceptsAddition("Please add an adapter at £20 extra.",q)).toBe(false);
  expect(acceptsAddition("Please add the PL to L mount adapter at £20 extra.",q)).toBe(true);
 });
 it("matches agreed money to the penny while tolerating floating-point arithmetic",()=>{
  const q=quote();
  expect(acceptsAddition("Please add the Blazar Remus 100mm and PL to L mount for £69.99 extra.",q)).toBe(false);
  const o=owner();o.quoted_additions[0].additional_cost_gbp=69.99;
  expect(acceptsAddition("Yes please.",q,o)).toBe(false);
  q.additional_cost_gbp=69.99999999999999;
  expect(acceptsAddition("Please add the Blazar Remus 100mm and PL to L mount for £70 extra.",q)).toBe(true);
 });
 it("does not require another confirmation for a clear lens-only request at the correct price",()=>{
  const q=quote();q.lines=q.lines.slice(0,1);q.total_gbp=174;q.additional_cost_gbp=50;
  expect(acceptsAddition("Don't add your PL to L mount adapter. I already have my own PL-to-L mount adapter. Please add the Blazar Remus 100mm lens only for 20 to 21 October, at £50 extra.",q)).toBe(true);
 });
});

it("scopes every amount in a direct addition's current/extra/full-total explanation",()=>{
 const good="Please add the Blazar Remus 100mm and PL to L mount for £70 extra, bringing the booking total to £194.";
 expect(acceptsAddition(good,quote())).toBe(true);
 const o=owner();o.body_text="Your current booking is £124. The Blazar Remus 100mm and PL to L mount cost £70 extra, bringing the total to £124.";
 expect(acceptsAddition("Yes please.",quote(),o)).toBe(false);
 for(const text of [good.replace("£194","£70"),good.replace("£70 extra","£194 extra"),good.replace("£70 extra","£70 less"),good.replace("£70 extra","£70 refund"),good.replace("£194","£194.001")])expect(acceptsAddition(text,quote())).toBe(false);
});

describe("complete Lab basket proposal acceptance",()=>{
 const offer={start_date:"2026-12-10",end_date:"2026-12-12",total_gbp:252,lines:[{product_id:1097510,name:"Sony FX3",quantity:2,total_gbp:252}]};
 it("accepts a clear multi-part date and quantity confirmation",()=>{
  expect(acceptsCompleteBasketOffer("Yes, please update it to two Sony FX3s for 10 to 12 December.",offer)).toBe(true);
  expect(acceptsCompleteBasketOffer("Yes, please update the request to two FX3s from 10 to 12 December at £252.",offer)).toBe(true);
  expect(acceptsCompleteBasketOffer("Yes, the Trafalgar Square area works for collection and return. Please update the request to 2 Sony FX3s for 10–12 December at the quoted £252.",offer)).toBe(true);
  expect(acceptsCompleteBasketOffer("Yes, the Trafalgar Square area works. Please update the request to 2 Sony FX3s for 10–12 December at the quoted £252 per day.",offer)).toBe(false);
  expect(acceptsCompleteBasketOffer("Yes, please update the request to one Sony FX3 for 10–12 December at the quoted £252.",offer)).toBe(false);
  expect(acceptsCompleteBasketOffer("Yes, please update it to two FX3s for 10 to 12 December at £252 per day.",offer)).toBe(false);
  expect(acceptsCompleteBasketOffer("Yes, please update it to two FX3s for 10 to 12 December at £260.",offer)).toBe(false);
 });
 it("accepts an unqualified answer to the one immediately preceding quote",()=>{
  expect(acceptsCompleteBasketOffer("Yes, please.",offer)).toBe(true);
 });
 it.each([
  "Maybe, yes.",
  "Yes, but only if you can do 11 to 12 December.",
  "Yes, please update it to one Sony FX3 for 10 to 12 December.",
  "Yes, please update it to two Sony FX3s for 11 to 12 December.",
  "Yes, but the total should be £200.",
  "Please quote two Sony FX3s for 10 to 12 December.",
  "No thanks, not yet.",
 ])("does not apply an unaccepted or conflicting offer: %s",text=>{
  expect(acceptsCompleteBasketOffer(text,offer)).toBe(false);
 });
});
