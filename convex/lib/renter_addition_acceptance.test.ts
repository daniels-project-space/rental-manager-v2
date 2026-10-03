import { describe, expect, it } from "vitest";
import { acceptsAddition, type AdditionAcceptanceQuote } from "./renter_addition_acceptance";
import type { SentAdditionProposal } from "./renter_sent_proposal";
const quote=():AdditionAcceptanceQuote=>({context_key:"base",start_date:"2026-10-20",end_date:"2026-10-21",total_gbp:194,additional_cost_gbp:70,lines:[{product_id:2,name:"Blazar Remus 100mm",qty:1,line_total_gbp:50},{product_id:3,name:"PL to L mount",qty:1,line_total_gbp:20}]});
const owner=()=>({body_text:"The Blazar Remus 100mm lens and PL to L mount adapter cost £70 extra for 20–21 October, bringing the booking total to £194. Shall I add both?",quoted_additions:[{context_key:"base",epoch:82,quoted_for_message_id:"previous",items:[{product_id:2,qty:1},{product_id:3,qty:1}],base_items:[{name:"BMPCC 6K Full Frame",quantity:1}],added_items:[{name:"Blazar Remus 100mm",quantity:1},{name:"PL to L mount",quantity:1}],start_date:"2026-10-20",end_date:"2026-10-21",total_gbp:194,additional_cost_gbp:70} satisfies SentAdditionProposal]});
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
