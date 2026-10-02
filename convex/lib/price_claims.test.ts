import {describe,it,expect} from "vitest";
import {unsupportedPriceClaims,type PriceEvidence} from "./price_claims";
import {guardDraft} from "./draft_guard";
import type {StockRequest} from "./stock_claims";
const request:StockRequest={start_date:"2026-10-02",end_date:"2026-10-04",items:[{name:"BMPCC 6K Full Frame",quantity:1}]};
const prices:PriceEvidence[]=[{names:["BMPCC 6K Pro"],kind:"rental",days:3,quantity:1,daily_rate_gbp:30,base_rate_gbp:35,total_gbp:90,start_date:"2026-10-02",end_date:"2026-10-04",call_id:"real-alt",source:"hygglo_tier"},
{names:["BMPCC 6K Full Frame"],kind:"rental",days:3,quantity:1,daily_rate_gbp:43.33,base_rate_gbp:50,total_gbp:130,call_id:"selected",source:"hygglo_tier"}];
const check=(text:string, evidence=prices,scope=request)=>unsupportedPriceClaims(text,evidence,scope);
describe("separate item prices after a parenthesized daily rate",()=>{
 const scope:StockRequest={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"BMPCC 6K Full Frame",quantity:1}]};
 const receipts:PriceEvidence[]=[
  {names:["Anamorphic Blazar Remus 100mm"],kind:"rental",days:2,quantity:1,total_gbp:50,daily_rate_gbp:25,source:"hygglo_tier",call_id:"native-lens"},
  {names:["PL to L mount"],kind:"rental",days:2,quantity:1,total_gbp:20,daily_rate_gbp:10,source:"hygglo_tier",call_id:"native-adapter"}];
 const text="For your 2-day hire from 20 to 21 October, the Blazar Remus 100mm is £50 (£25/day) and the PL to L mount adapter is £20 (£10/day).";
 it("binds each amount to its own item rather than combining the prior rate suffix",()=>{
  expect(check(text,receipts,scope)).toEqual([]);
  expect(check(text.replace("and the","plus the"),receipts,scope)).toEqual([]);
 });
 it("still requires the second item's real total, duration and quantity",()=>{
  expect(check(text,[receipts[0]],scope)).not.toEqual([]);
  expect(check(text.replace("£20","£25"),receipts,scope)).not.toEqual([]);
  expect(check(text,[receipts[0],{...receipts[1],days:3}],scope)).not.toEqual([]);
  expect(check(text,[receipts[0],{...receipts[1],quantity:2}],scope)).not.toEqual([]);
 });
 it("does not accept a combined lens-and-adapter price from separate receipts",()=>{
  expect(check("The Blazar Remus 100mm and the PL to L mount adapter are £50 for the two days.",receipts,scope)).not.toEqual([]);
 });
});
describe("booking and duration price ownership beside component lists",()=>{
 const scope:StockRequest={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"Blackmagic 6K Full Frame + Canon EF 24-105mm f4",quantity:1}]};
 const quote:PriceEvidence={names:[scope.items[0].name],kind:"rental",days:2,quantity:1,total_gbp:124,call_id:"native-current",source:"lab_order_quote"};
 const other:PriceEvidence={names:["Canon EF 24-105mm f4"],kind:"rental",days:2,quantity:1,total_gbp:40,call_id:"native-lens",source:"hygglo_tier"};
 const text="Canon EF 24-105mm f4 is in your kit. Your booking remains unchanged at £124 for the 2 days, with the 1 EF-to-L adapter, Canon EF 24-105mm f/4 lens, batteries, and CFexpress card all included as booked.";
 it("binds an unchanged amount to the exact current order rather than the preceding or trailing lens",()=>expect(unsupportedPriceClaims(text,[quote,other],scope)).toEqual([]));
 it("requires the exact total, members, quantity and duration of the current order",()=>{
  for(const changed of [text.replace("£124","£40"),text.replace("2 days","3 days")]) expect(unsupportedPriceClaims(changed,[quote,other],scope)).not.toEqual([]);
  expect(unsupportedPriceClaims(text,[other],scope)).not.toEqual([]);
  expect(unsupportedPriceClaims(text,[{...quote,quantity:2}],scope)).not.toEqual([]);
  const multi={...scope,items:[...scope.items,{name:"Sony FX3",quantity:1}]};
  expect(unsupportedPriceClaims(text,[quote],multi)).not.toEqual([]);
  expect(unsupportedPriceClaims(text,[{names:[],kind:"basket",items:multi.items,days:2,total_gbp:124,call_id:"native-order",source:"order_quote"}],multi)).toEqual([]);
 });
 it("does not treat a duration-first trailing contents list as a post-price item reference",()=>{
  expect(unsupportedPriceClaims(`${scope.items[0].name} is £124 for the 2 days, with Canon EF 24-105mm f4 included.`,[quote,other],scope)).toEqual([]);
  expect(unsupportedPriceClaims("£40 for Canon EF 24-105mm f4 for the 2 days.",[quote,other],scope)).toEqual([]);
 });
});
describe("receipted lens shorthand",()=>{
 const scope:StockRequest={items:[{name:"BMPCC 6K Full Frame + Canon EF 24-105mm f4",quantity:1}],start_date:"2026-10-20",end_date:"2026-10-21"};
 const lens:PriceEvidence={names:["Canon EF 16-35mm f2.8"],kind:"rental",days:2,quantity:1,daily_rate_gbp:20,total_gbp:40,call_id:"native-lens",source:"hygglo_tier"};
 const basket:PriceEvidence={names:[],kind:"basket",items:[...scope.items,{name:lens.names[0],quantity:1}],proposal:{base_items:scope.items,added_items:[{name:lens.names[0],quantity:1}]},days:2,total_gbp:164,call_id:"native-proposal",source:"native_lab_proposal"};
 const text="We have a compatible Canon EF 16-35mm f2.8 wide-angle zoom. Adding the 16-35mm would be £40 for the 2 days (£20/day), which would bring your total booking to £164.";
 it("accepts a unique focal-range shorthand without losing the proposed basket scope",()=>expect(unsupportedPriceClaims(text,[lens,basket],scope)).toEqual([]));
 it("resolves Adding that from the last named receipted alternative",()=>{
  expect(unsupportedPriceClaims(text.replace("Adding the 16-35mm","Adding that"),[lens,basket],scope)).toEqual([]);
  expect(unsupportedPriceClaims(text.replace("Adding the 16-35mm","Adding that").replace("£164","£124"),[lens,basket],scope)).not.toEqual([]);
 });
 it("keeps duration-qualified pronouns bound to their item and validates spelled-out durations",()=>{
  for(const phrase of ["Adding that for the 2 days","Adding it for two days","Adding this for your two-day hire"])
   expect(unsupportedPriceClaims(text.replace("Adding the 16-35mm",phrase),[lens,basket],scope),phrase).toEqual([]);
  for(const days of ["three","twenty one","twenty-one","zero","one hundred","a few","2-3"])
   expect(unsupportedPriceClaims(`Canon EF 16-35mm f2.8 is £40 for ${days} days.`,[lens],scope)).not.toEqual([]);
  expect(unsupportedPriceClaims(text.replace("Adding the 16-35mm","Adding that for three days"),[lens,basket],scope)).not.toEqual([]);
 });
 it("separates a duration/calendar preface from its grounded pronoun without discarding scope",()=>{
  const dated=[lens,basket].map(e=>({...e,start_date:scope.start_date!,end_date:scope.end_date!}));
  const preface="Canon EF 16-35mm f2.8 is available. For the 2-day hire (20 to 21 October), it is £20/day (£40 total), which would bring your booking total to £164.";
  expect(unsupportedPriceClaims(preface,dated,scope)).toEqual([]);
  expect(unsupportedPriceClaims(preface.replace("2-day","two-day"),dated,scope)).toEqual([]);
  expect(unsupportedPriceClaims(preface.replace("the 2-day hire (20 to 21 October),","20 to 21 October,"),dated,scope)).toEqual([]);
  for(const wrong of [preface.replace("20 to 21","22 to 23"),preface.replace("20 to 21","32 to 33"),preface.replace("2-day","three-day"),preface.replace("2-day","a few-day"),preface.replace("£40","£50"),preface.replace("£164","£124"),preface.replace("it is","Canon RF 16-35mm is"),preface.replace("it is","two Canon EF 16-35mm f2.8 lenses are")])
   expect(unsupportedPriceClaims(wrong,dated,scope),wrong).not.toEqual([]);
 });
 it("requires the explicitly declared brand/mount instead of borrowing its bare focal range",()=>{
  expect(unsupportedPriceClaims("EF 16-35mm is £40 for the 2 days.",[lens],scope)).toEqual([]);
  const rf={...lens,names:["Canon RF 16-35mm f2.8"],daily_rate_gbp:30,total_gbp:60,call_id:"native-rf"};
  expect(unsupportedPriceClaims("Canon RF 16-35mm is £60 for the 2 days.",[lens,rf],scope)).toEqual([]);
  expect(unsupportedPriceClaims("Canon RF 16-35mm is £40 for the 2 days.",[lens,rf],scope)).not.toEqual([]);
  const sigma={...lens,names:["Sigma EF 16-35mm f2.8"],call_id:"native-sigma"};
  expect(unsupportedPriceClaims("EF 16-35mm is £40 for the 2 days.",[lens,sigma],scope)).not.toEqual([]);
  for(const name of ["Canon RF 16-35mm","RF 16-35mm","Sony E 16-35mm","Sigma EF 16-35mm"])
   expect(unsupportedPriceClaims(`${name} is £40 for the 2 days.`,[lens],scope)).not.toEqual([]);
 });
 it("keeps a generic kit-owner aside out of a lens's price identity",()=>{
  const dated=[lens,basket].map(e=>({...e,start_date:scope.start_date!,end_date:scope.end_date!}));
  const reply="The Canon EF 16-35mm f2.8 is fully compatible since your booked Blackmagic kit already includes the EF to L mount adapter.\n\nIt is available for 20 to 21 October. Adding it would be £40 for the 2 days (£20/day), which would bring your total booking to £164.";
  expect(unsupportedPriceClaims(reply,dated,scope)).toEqual([]);
  for(const wrong of [reply.replace("£40","£60"),reply.replace("£20","£30"),reply.replace("£164","£124"),reply.replace("2 days","3 days"),reply.replace("Adding it","Blackmagic 8K Mystery is"),reply.replace("Adding it","Canon RF 16-35mm is")])
   expect(unsupportedPriceClaims(wrong,dated,scope),wrong).not.toEqual([]);
  expect(unsupportedPriceClaims("Canon EF 16-35mm f2.8 is available. Blackmagic 8K Mystery is another model. It is £40 for the 2 days.",dated,scope)).not.toEqual([]);
 });
 it("resolves adding pronouns after stripping a leading hire duration",()=>{
  const dated=[lens,basket].map(e=>({...e,start_date:scope.start_date!,end_date:scope.end_date!}));
  const reply="Canon EF 16-35mm f2.8 is available for 20 to 21 October. For the 2 days, adding it would be £40 (£20/day), which would bring the total booking to £164.";
  expect(unsupportedPriceClaims(reply,dated,scope)).toEqual([]);
  for(const wrong of [reply.replace("2 days","3 days"),reply.replace("For the 2 days,","For 22 to 23 October,"),reply.replace("£40","£60"),reply.replace("£20","£30"),reply.replace("£164","£124"),reply.replace("adding it","adding Canon RF 16-35mm")])
   expect(unsupportedPriceClaims(wrong,dated,scope),wrong).not.toEqual([]);
 });
 it("shares brand and mount disambiguation without borrowing a kit's price",()=>{
  const shorthand="Canon 16-35mm is £40 for the 2 days.";
  expect(unsupportedPriceClaims(shorthand,[lens],scope)).toEqual([]);
  expect(unsupportedPriceClaims(shorthand,[lens,{...lens,names:["Sony E 16-35mm f2.8"]}],scope)).toEqual([]);
  expect(unsupportedPriceClaims(shorthand,[lens,{...lens,names:["Canon RF 16-35mm f2.8"]}],scope)).not.toEqual([]);
  expect(unsupportedPriceClaims("16-35mm is £40 for the 2 days.",[{...lens,names:["Sony FX3 + Canon EF 16-35mm f2.8 kit"]}],scope)).not.toEqual([]);
  expect(unsupportedPriceClaims("16-35mm is £40 for the 2 days.",[{...lens,names:["Canon EF 16-35mm filter"]}],scope)).not.toEqual([]);
 });
 it("still refuses ambiguous ranges, wrong prices, dates and quantities",()=>{
  const other={...lens,names:["Sony E 16-35mm f2.8"],call_id:"other-lens"};
  expect(unsupportedPriceClaims(text,[lens,other,basket],scope)).not.toEqual([]);
  for (const changed of [text.replace("£40","£50"),text.replace("£164","£124"),text.replace("Adding the","Adding two"),text.replace("2 days","3 days"),text.replace("16-35mm would","16-50mm would")])
   expect(unsupportedPriceClaims(changed,[lens,basket],scope),changed).not.toEqual([]);
 });
});
describe("original booking and proposed alternative prices",()=>{
 const original:StockRequest={start_date:"2026-10-06",end_date:"2026-10-07",items:[{name:"Sony FX3",quantity:1}]};
 const ledger:PriceEvidence[]=[{names:["Sony FX3"],kind:"rental",days:2,quantity:1,total_gbp:98,start_date:"2026-10-06",end_date:"2026-10-07",call_id:"original",source:"lab_order_quote"},
  {names:["Sony A7 V"],kind:"rental",days:3,quantity:1,total_gbp:110,start_date:"2026-10-06",end_date:"2026-10-08",call_id:"alternative",source:"hygglo_tier"}];
 it("keeps the captured unchanged booking and proposed three-day alternative separate",()=>{
  const text="Your booking remains set for 6 to 7 October as confirmed, which is £98 total.\n\nIf you need a camera covering the full 6 to 8 October window, I do have the Sony A7 V available for those 3 days at £110 total.";
  expect(unsupportedPriceClaims(text,ledger,original)).toEqual([]);
 });
 it("cannot turn a booking reference into an unrelated camera's price",()=>{
  expect(unsupportedPriceClaims("Your booking for the Pyxis remains set for 6 to 7 October, which is £98 total.",ledger,original)).toHaveLength(1);
  expect(unsupportedPriceClaims("The A7 V is £110 for 6 to 9 October.",ledger,original)).toHaveLength(1);
 });
});
describe("scoped rental price claims",()=>{
 it("accepts exact-duration totals and separates the one-day base rate",()=>{
  expect(check("The Blackmagic 6K Pro is £90 total for 3 days (£30/day).")).toEqual([]);
  expect(check("The BMPCC 6K Pro is £90 total for 3 days (£35/day).")).toHaveLength(1);
  expect(check("The BMPCC 6K Pro has a one-day base rate of £35/day.")).toEqual([]);
 });
 it("cannot borrow a different camera's real quote or a fabricated multiplier",()=>{
  expect(check("The Blackmagic 6K Full Frame is £90 total for 3 days.")).toHaveLength(1);
  expect(check("The Pyxis is £90 total for 3 days.")).toHaveLength(1);
  expect(check("The Canon RF 24-70mm is £130 total for 3 days.")).toHaveLength(1);
  expect(check("The Blackmagic 6K Pro is £270 total for 3 days.")).toHaveLength(1);
 });
 it("checks explicit duration, quantities and dates",()=>{
  expect(check("The BMPCC 6K Pro is £90 total for 4 days.")).toHaveLength(1);
  expect(check("Two BMPCC 6K Pro cameras are £90 total for 3 days.")).toHaveLength(1);
  expect(check("The BMPCC 6K Pro is £90 for 2026-10-05 to 2026-10-07.")).toHaveLength(1);
  expect(check("The BMPCC 6K Pro is £90 total for 3 days.",prices,{...request,items:[{name:"BMPCC 6K Full Frame",quantity:2}]})).toHaveLength(1);
 });
 it("distinguishes per-unit prices from explicit group totals and group daily rates",()=>{
  const p:PriceEvidence={names:["Sony FX3"],kind:"rental",days:3,quantity:2,daily_rate_gbp:30,total_gbp:180,call_id:"two-fx3",source:"tier"};
  const scope={...request,items:[{name:"Sony FX3",quantity:2}]};
  expect(check("Two FX3 cameras are £180 total for 3 days.",[p],scope)).toEqual([]);
  expect(check("Two FX3 cameras are £60/day.",[p],scope)).toEqual([]);
  expect(check("Two FX3 cameras are £30/day per camera.",[p],scope)).toEqual([]);
  expect(check("The FX3 is £90 each for 3 days.",[p],scope)).toEqual([]);
  expect(check("Two FX3 cameras are £90 total for 3 days.",[p],scope)).toHaveLength(1);
 });
 it("does not round away pennies or manufacture fees from price bands",()=>{
  for(const text of ["The Full Frame is £43/day.","Delivery is £30.","A deposit is £90."])expect(check(text)).toHaveLength(1);
  const fx:PriceEvidence={names:["Sony FX3"],kind:"rental",days:3,quantity:1,daily_rate_gbp:25.71,total_gbp:77,call_id:"fx",source:"tier"};
  expect(check("The FX3 is £25.71/day.",[fx])).toEqual([]);
  expect(check("The FX3 is £26/day.",[fx])).toHaveLength(1);
 });
 it("does not license rental prices with replacement values",()=>{
  const p:PriceEvidence={names:["Sony FX3"],kind:"replacement",total_gbp:3000,call_id:"context",source:"inventory"};
  expect(check("The FX3 is £3000 total.",[p])).toHaveLength(1);
  expect(check("The FX3 replacement value is £3,000.",[p])).toEqual([]);
 });
 it("checks each item in mixed price statements independently",()=>{
  expect(check("The BMPCC 6K Pro is £90 total for 3 days; the BMPCC 6K Full Frame is £130 total for 3 days.")).toEqual([]);
  expect(check("The BMPCC 6K Pro is £130 total for 3 days; the BMPCC 6K Full Frame is £90 total for 3 days.")).toHaveLength(2);
 });
 it("requires an actual basket total rather than sums of alternative quotes",()=>{
  expect(check("The combined total is £220.")).toHaveLength(1);
  const basket:PriceEvidence={names:[],items:[{name:"BMPCC 6K Full Frame",quantity:1}],kind:"basket",total_gbp:220,days:3,call_id:"order",source:"order_quote"};
  expect(check("The combined total is £220.",[...prices,basket])).toEqual([]);
 });
 it("cannot label one item's quote as a joint basket, or borrow a basket with different members",()=>{
  const scope={...request,items:[{name:"BMPCC 6K Pro",quantity:1},{name:"BMPCC 6K Full Frame",quantity:1}]};
  expect(check("The BMPCC 6K Pro and BMPCC 6K Full Frame are £90 total for 3 days.",prices,scope)).toHaveLength(1);
  expect(check("The BMPCC 6K Pro + BMPCC 6K Full Frame are £90 total for 3 days.",prices,scope)).toHaveLength(1);
  expect(check("The BMPCC 6K Full Frame with a Pyxis is £130 total for 3 days.")).toHaveLength(1);
  const basket:PriceEvidence={names:[],items:scope.items,kind:"basket",total_gbp:220,days:3,call_id:"basket",source:"order"};
  expect(check("The BMPCC 6K Pro and BMPCC 6K Full Frame are £220 total for 3 days.",[...prices,basket],scope)).toEqual([]);
  expect(check("The combined total is £220.",[...prices,basket],request)).toHaveLength(1);
 });
 it("new contract overrides old permissive numeric whitelists",()=>{
  const g=guardDraft("The BMPCC 6K Full Frame is £90 total for 3 days.",{history:[],lastRenterMessage:"Price?",hasItemGrounding:true,priceEvidence:prices,stockRequest:request,factPack:{pricing:{itemPrices:[{name:"Full Frame",min:1,max:1000}],offeredPrices:[90]}}});
  expect(g.flags).toContainEqual(expect.objectContaining({type:"PRICE_HALLUCINATION",severity:"critical"}));
 });
});
it("keeps duration-qualified generic totals tied to the actual subject",()=>{
 const scope:StockRequest={start_date:"2026-10-06",end_date:"2026-10-07",items:[{name:"Sony A7 II",quantity:1}]};
 const evidence:PriceEvidence[]=[{names:["Sony A7 II"],kind:"rental",days:2,quantity:1,total_gbp:56,daily_rate_gbp:28,source:"native",call_id:"native"}];
 expect(unsupportedPriceClaims("The Sony A7 II kit is available. The total for the 2 days is £56.",evidence,scope)).toEqual([]);
 expect(unsupportedPriceClaims("The total for the 4-day rental is £56.",evidence,scope)).toHaveLength(1);
 expect(unsupportedPriceClaims("The total for the Pyxis is £56.",evidence,scope)).toHaveLength(1);
});
it("qualifies a revised total against the amended native quote without borrowing another model",()=>{
 const scope:StockRequest={start_date:"2026-09-30",end_date:"2026-10-03",items:[{name:"Sony A7 V",quantity:1}]};
 const evidence:PriceEvidence[]=[{names:["Sony A7 V"],kind:"rental",days:4,quantity:1,total_gbp:147,start_date:scope.start_date!,end_date:scope.end_date!,source:"lab_order_quote",call_id:"post-amendment"}];
 const text="I've updated the booking dates to 30 September to 3 October (4 days). The new total is £147.";
 expect(unsupportedPriceClaims(text,evidence,scope)).toEqual([]);
 expect(unsupportedPriceClaims(text.replace("£147","£148"),evidence,scope)).toHaveLength(1);
 expect(unsupportedPriceClaims("The updated total for the Pyxis is £147.",evidence,scope)).toHaveLength(1);
 expect(unsupportedPriceClaims("The revised total for 3 days is £147.",evidence,scope)).toHaveLength(1);
});
it("requires the revised basket total to have the same native members",()=>{
 const scope:StockRequest={start_date:"2026-10-06",end_date:"2026-10-08",items:[{name:"Sony A7 V",quantity:1},{name:"Sony GM 24-70mm f2.8",quantity:1}]};
 const basket:PriceEvidence={names:[],kind:"basket",items:scope.items,days:3,total_gbp:170,source:"lab_order_quote",call_id:"native"};
 expect(unsupportedPriceClaims("The updated total is £170.",[basket],scope)).toEqual([]);
 expect(unsupportedPriceClaims("The updated total is £170.",[{...basket,items:[scope.items[0]]}],scope)).toHaveLength(1);
});

it("keeps an explicit current booking total separate from the preceding extra-item quote",()=>{
 const scope:StockRequest={start_date:"2026-10-06",end_date:"2026-10-07",items:[{name:"Sony A7 II",quantity:1}]};
 const evidence:PriceEvidence[]=[{names:["Sony 28-70mm"],kind:"rental",total_gbp:36,daily_rate_gbp:18,days:2,quantity:1,source:"native",call_id:"lens"},{names:[],items:scope.items,kind:"basket",total_gbp:56,days:2,start_date:scope.start_date!,end_date:scope.end_date!,source:"native_order",call_id:"current"}];
 const failures=unsupportedPriceClaims("The Sony 28-70mm is £36 for the 2 days (£18/day), which would bring your booking total from £56 to £92.",evidence,scope);
 expect(failures, JSON.stringify(failures)).toHaveLength(1);expect(failures[0]).toContain("£92");
 expect(unsupportedPriceClaims("The Pyxis booking total is £56.",evidence,scope)).toHaveLength(1);
});

it("checks your updated total against the amended native basket without borrowing it for the lens rate",()=>{
 const scope:StockRequest={start_date:"2026-10-06",end_date:"2026-10-07",items:[{name:"Sony A7 II",quantity:1},{name:"Sony 28-70mm",quantity:1}]};
 const evidence:PriceEvidence[]=[{names:["Sony 28-70mm"],kind:"rental",total_gbp:36,daily_rate_gbp:18,days:2,quantity:1,source:"native",call_id:"lens"},{names:[],items:scope.items,kind:"basket",total_gbp:92,days:2,start_date:scope.start_date!,end_date:scope.end_date!,source:"native_order",call_id:"amended"}];
 for(const wording of ["your updated total", "your total", "your revised booking total", "your booking revised total"]) {
  const text=`I've added the extra Sony 28-70mm lens to your booking for 6 to 7 October. That's £36 for the 2 days (£18/day), bringing ${wording} to £92.`;
  expect(unsupportedPriceClaims(text,evidence,scope),wording).toEqual([]);
  expect(unsupportedPriceClaims(text,[evidence[0],{...evidence[1],items:[scope.items[0]]}],scope),wording).toHaveLength(1);
 }
});
