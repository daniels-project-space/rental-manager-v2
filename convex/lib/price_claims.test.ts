import calendarRateFixture from "../../src/lib/fixtures/renter-calendar-rate-price-claim.json";
import swapPriceFixture from "../../src/lib/fixtures/renter-swap-price-evidence.json";
import swapComparison from "../../src/lib/fixtures/renter-swap-comparison.json";
import {describe,it,expect} from "vitest";
import {unsupportedPriceClaims,type PriceEvidence} from "./price_claims";
import {guardDraft} from "./draft_guard";
import type {StockRequest} from "./stock_claims";
const request:StockRequest={start_date:"2026-10-02",end_date:"2026-10-04",items:[{name:"BMPCC 6K Full Frame",quantity:1}]};
const prices:PriceEvidence[]=[{names:["BMPCC 6K Pro"],kind:"rental",days:3,quantity:1,daily_rate_gbp:30,base_rate_gbp:35,total_gbp:90,start_date:"2026-10-02",end_date:"2026-10-04",call_id:"real-alt",source:"hygglo_tier"},
{names:["BMPCC 6K Full Frame"],kind:"rental",days:3,quantity:1,daily_rate_gbp:43.33,base_rate_gbp:50,total_gbp:130,call_id:"selected",source:"hygglo_tier"}];
const check=(text:string, evidence=prices,scope=request)=>unsupportedPriceClaims(text,evidence,scope);
describe("a verified replacement proposal", () => {
 const scope:StockRequest={start_date:"2026-11-26",end_date:"2026-11-26",items:[{name:"BMPCC 6K Full Frame",quantity:1}]};
 const replacement:PriceEvidence={names:[],kind:"basket",days:1,total_gbp:18,start_date:scope.start_date!,end_date:scope.end_date!,
  items:[{name:"Sony A7 III",quantity:1}],source:"native_lab_proposal",call_id:"proposal",
  proposal:{base_items:scope.items,added_items:[{name:"Sony A7 III",quantity:1}],removed_items:scope.items,base_total_gbp:50}};
 const line:PriceEvidence={names:["Sony A7 III"],kind:"rental",days:1,quantity:1,total_gbp:18,start_date:scope.start_date!,end_date:scope.end_date!,
  source:"native_lab_proposal",call_id:"proposal:line:1046235",quote_role:"addition"};
 const text="As an alternative, I'd recommend our Sony A7 III Camera Body Kit. Swapping to the Sony A7 III would bring the rental total to £18 for the day.";
 it("accepts the exact replacement total with its matching source basket",()=>expect(check(text,[replacement,line],scope)).toEqual([]));
 it("rejects different amounts, dates, cameras and unproven replacement baskets",()=>{
  for(const changed of [text.replace("£18","£50"),text.replace("Sony A7 III would","Sony FX3 would"),text.replace("for the day","for 3 days")])
   expect(check(changed,[replacement,line],scope),changed).not.toEqual([]);
  expect(check(text,[line],scope)).not.toEqual([]);
  expect(check(text,[{...replacement,start_date:"2026-11-27"},line],scope)).not.toEqual([]);
  const longer={...scope,end_date:"2026-11-27"};
  expect(check(text,[{...replacement,days:2,end_date:longer.end_date}, {...line,days:2,end_date:longer.end_date}],longer)).not.toEqual([]);
  expect(check(text.replace("for the day","for the day and for 3 days"),[replacement,line],scope)).not.toEqual([]);
 });
});
describe("a replacement saving from the actual Lab quote",()=>{
 const evidence=swapPriceFixture.evidence as PriceEvidence[];
 const scope=swapPriceFixture.request as StockRequest;
 const sentence="Switching from the BMPCC 6K Full Frame to the Sony A7 III would bring your total to £18 for the day, which is £32 less.";
 it("accepts the calculated saving when both named items and the exact before/after basket are verified",()=>expect(check(sentence,evidence,scope)).toEqual([]));
 it("does not accept an unproven saving or a different removed or added item",()=>{
  for(const changed of [sentence.replace("£32", "£33"),sentence.replace("BMPCC 6K Full Frame", "BMPCC 6K Pro"),sentence.replace("Sony A7 III", "Sony FX3")])expect(check(changed,evidence,scope)).not.toEqual([]);
 });
});
it("checks all three amounts in a captured replacement comparison against the right saved basket",()=>{
 const sentence="Swapping the Blackmagic 6K FF for the Sony A7 III on 29 November would bring the total to £18 (a £32 reduction from £50).";
 const evidence=swapComparison.evidence as PriceEvidence[],scope=swapComparison.request as StockRequest;
 expect(check(sentence,evidence,scope)).toEqual([]);
 for(const altered of [sentence.replace("£18","£19"),sentence.replace("£32","£31"),sentence.replace("£50","£51")])expect(check(altered,evidence,scope)).not.toEqual([]);
});
describe("a dated single-item rental total", () => {
 const scope:StockRequest={start_date:"2026-11-26",end_date:"2026-11-26",items:[{name:"BMPCC 6K Full Frame",quantity:1}]};
 const quote:PriceEvidence={names:[scope.items[0].name],kind:"rental",days:1,quantity:1,total_gbp:50,start_date:scope.start_date!,end_date:scope.end_date!,call_id:"test",source:"lab_order_quote"};
 const text="For your requested date on 26 November (1 day), the camera rental total is £50.";
 it("accepts the current item's exact dated amount",()=>expect(check(text,[quote],scope)).toEqual([]));
 it("still rejects a changed amount, date, duration, quantity, or different model",()=>{
  for(const changed of [text.replace("£50","£60"),text.replace("26 November","27 November"),text.replace("1 day","2 days"),text.replace("camera rental","Sony FX3 rental")])
   expect(check(changed,[quote],scope),changed).not.toEqual([]);
  expect(check(text,[{...quote,quantity:2}],scope)).not.toEqual([]);
 });
});
describe("a quoted date change with a parenthesized comparison", () => {
 const scope:StockRequest={start_date:"2026-12-11",end_date:"2026-12-11",items:[{name:"BMPCC 6K Full Frame",quantity:1}]};
 const proposal:PriceEvidence={names:[],kind:"basket",days:2,total_gbp:100,start_date:"2026-12-12",end_date:"2026-12-13",
  items:[{name:"BMPCC 6K Full Frame",quantity:1}],call_id:"native-date-proposal",source:"native_lab_date_proposal",
  date_proposal:{before_context_key:"current-booking",from_start_date:scope.start_date!,from_end_date:scope.end_date!,base_total_gbp:50,physical_identity_key:"same-physical-basket"}};
 const base:PriceEvidence={names:["BMPCC 6K Full Frame"],kind:"basket",days:1,total_gbp:50,start_date:scope.start_date!,end_date:scope.end_date!,
  items:[{name:"BMPCC 6K Full Frame",quantity:1}],call_id:"current-booking",source:"lab_order_quote"};
 const baseLine:PriceEvidence={names:["BMPCC 6K Full Frame"],kind:"rental",days:1,quantity:1,total_gbp:50,start_date:scope.start_date!,end_date:scope.end_date!,
  call_id:"current-booking:line",source:"lab_order_quote"};
 const text="Moving your BMPCC 6K Full Frame rental to 12–13 December (2 days) is available and would bring the total to £100 (a £50 difference from your current £50 total). Would you like me to update the request to those dates?";
 it("treats the parenthetical old/new amount as a comparison and accepts the exact native date quote",()=>{
  expect(check(text,[base,baseLine,proposal],scope)).toEqual([]);
 });
 it("still rejects a changed proposed total or date span",()=>{
  expect(check(text.replace("£100","£101"),[base,baseLine,proposal],scope)).not.toEqual([]);
  expect(check(text.replace("12–13 December","13–14 December"),[base,baseLine,proposal],scope)).not.toEqual([]);
 });
 it("grounds a quoted date-change increase to the exact old and new totals",()=>{
  const actual="Moving the BMPCC 6K Full Frame kit to 12–13 December (2 days) would bring the rental total to £100 (an increase of £50 from the current 1-day total). The kit is fully available for those dates.";
  expect(check(actual,[base,baseLine,proposal],scope)).toEqual([]);
  const proposedScope={...scope,start_date:"2026-12-12",end_date:"2026-12-13"};
  expect(check(actual,[base,baseLine,proposal],proposedScope)).toEqual([]);
  expect(check(actual.replace("increase of £50","increase of £49"),[base,baseLine,proposal],scope)).not.toEqual([]);
  expect(check(actual.replace("increase of £50","increase of £49"),[base,baseLine,proposal],proposedScope)).not.toEqual([]);
  expect(check(actual,[baseLine,proposal],proposedScope)).not.toEqual([]);
 });
 it("grounds the exact natural-language date-change comparison returned by the Lab retry",()=>{
  const actual="Changing your request for the BMPCC 6K Full Frame kit to 12–13 December (2 days) would bring the total to £100, which is a £50 difference from your current £50 total. Let me know if you would like me to go ahead and update the dates for you.";
  const proposedScope={...scope,start_date:"2026-12-12",end_date:"2026-12-13"};
  expect(check(actual,[base,baseLine,proposal],proposedScope)).toEqual([]);
  expect(check(actual.replace("£50 difference","£49 difference"),[base,baseLine,proposal],proposedScope)).not.toEqual([]);
  expect(check(actual.replace("current £50 total","current £51 total"),[base,baseLine,proposal],proposedScope)).not.toEqual([]);
  expect(check(actual,[baseLine,proposal],proposedScope)).not.toEqual([]);
 });
 it("accepts a date-change delta phrased as a difference from the current request",()=>{
  const actual="Changing the dates to 12–13 December (2 days) for the BMPCC 6K Full Frame kit would bring the revised total to £100 (a difference of £50 from your current 1-day request). Let me know if you would like me to go ahead and update the dates on your request.";
  const proposedScope={...scope,start_date:"2026-12-12",end_date:"2026-12-13"};
  expect(check(actual,[base,baseLine,proposal],proposedScope)).toEqual([]);
  for(const changed of [actual.replace("difference of £50","difference of £49"),actual.replace("current 1-day request","current 2-day request"),actual.replace("£100","£101")])
   expect(check(changed,[base,baseLine,proposal],proposedScope),changed).not.toEqual([]);
  expect(check(actual,[baseLine,proposal],proposedScope)).not.toEqual([]);
 });
 it("accepts the exact follow-up proposal wording with a quoted current booking total",()=>{
  const actual="Changing your request for the BMPCC 6K Full Frame kit to 12–13 December (2 days) would bring the total to £100 (an increase of £50 from your current £50 booking). Let me know if you would like me to go ahead and update the dates on your request.";
  const proposedScope={...scope,start_date:"2026-12-12",end_date:"2026-12-13"};
  expect(check(actual,[base,baseLine,proposal],proposedScope)).toEqual([]);
  for(const changed of [actual.replace("£100","£101"),actual.replace("increase of £50","increase of £49"),actual.replace("current £50 booking","current £51 booking")])
   expect(check(changed,[base,baseLine,proposal],proposedScope),changed).not.toEqual([]);
  expect(check(actual,[baseLine,proposal],proposedScope)).not.toEqual([]);
 });
});
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

it("validates the deterministic confirmation against its accepted Lab transaction receipt",()=>{
 const scope:StockRequest={start_date:"2026-12-10",end_date:"2026-12-12",items:[{name:"Sony FX3",quantity:2}]};
 const receipt:PriceEvidence={names:["Sony FX3"],kind:"basket",items:scope.items,days:3,total_gbp:252,start_date:scope.start_date!,end_date:scope.end_date!,
  source:"lab_order_transaction",call_id:"lab-action:accepted-complete-basket"};
 const text="Done — I've updated the items and rental dates as agreed. The new total is £252.00.";
 expect(unsupportedPriceClaims(text,[receipt],scope)).toEqual([]);
 expect(unsupportedPriceClaims(text.replace("£252.00","£251.00"),[receipt],scope)).toHaveLength(1);
 expect(unsupportedPriceClaims(text,[{...receipt,items:[{name:"Sony FX3",quantity:1}]}],scope)).toHaveLength(1);
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

it("rejects an incomplete required-adapter quote while allowing grounded component or complete prices", async () => {
 const { incompleteSetupQuotes } = await import("./price_claims");
 const evidence: any[] = [{ names: ["Blazar Remus 100mm"], kind: "rental", total_gbp: 50, required_accessory_names: ["PL to L mount"], call_id: "lens", source: "hygglo_tier" },
  { names: ["PL to L mount"], kind: "rental", daily_rate_gbp: 10, total_gbp: 20, call_id: "adapter", source: "hygglo_tier" },
  { names: [], kind: "basket", total_gbp: 70, proposal: { base_items: [], added_items: [{ name: "Blazar Remus 100mm", quantity: 1 }, { name: "PL to L mount", quantity: 1 }] }, call_id: "whole", source: "native_lab_proposal" }];
 expect(incompleteSetupQuotes("Blazar Remus 100mm is £50 for your dates. You need my PL to L mount adapter, which is available.", evidence)).toHaveLength(1);
 expect(incompleteSetupQuotes("Blazar Remus 100mm is £50 and the PL to L mount adapter is £20 for your dates.", evidence)).toEqual([]);
 expect(incompleteSetupQuotes("Blazar Remus 100mm with my PL to L mount adapter would be £70 extra in total.", evidence)).toEqual([]);
 expect(incompleteSetupQuotes("Blazar Remus 100mm is unavailable. Your booking remains £124.", evidence)).toEqual([]);
});

describe("a single-item addition followed by a combined basket total",()=>{
 const scope:StockRequest={start_date:"2026-12-13",end_date:"2026-12-13",items:[{name:"BMPCC 6K Full Frame",quantity:1}]};
 const added=[{name:"BMPCC 6K Pro",quantity:1}];
 const receipts:PriceEvidence[]=[
  {names:["BMPCC 6K Full Frame"],kind:"rental",days:1,quantity:1,daily_rate_gbp:50,total_gbp:50,start_date:scope.start_date!,end_date:scope.end_date!,source:"lab_order_quote",call_id:"current-line"},
  {names:["BMPCC 6K Pro","Blackmagic BMPCC6K 6K Pro Digital Cinema Camera | SSD Cage Sony Monitor Video"],kind:"rental",days:1,quantity:1,daily_rate_gbp:35,total_gbp:35,source:"hygglo_tier",call_id:"server-price"},
  {names:["BMPCC 6K Pro"],kind:"rental",days:1,quantity:1,daily_rate_gbp:35,total_gbp:35,start_date:scope.start_date!,end_date:scope.end_date!,quote_role:"addition",source:"native_lab_proposal",call_id:"proposal:line"},
  {names:[],kind:"basket",days:1,total_gbp:85,start_date:scope.start_date!,end_date:scope.end_date!,items:[...scope.items,...added],source:"native_lab_proposal",call_id:"proposal",proposal:{base_items:scope.items,added_items:added,additional_cost_gbp:35}},
 ];
 const text="The BMPCC 6K Pro is available on 13 December 2026. Adding it would be an extra £35, bringing the combined total to £85 for the 1-day rental. Let me know if you would like me to go ahead and update the request.";
 it("accepts the exact source-backed total after the separately quoted addition price",()=>expect(check(text,receipts,scope)).toEqual([]));
 it("keeps amount, item and receipt dates tied to the proposed basket",()=>{
  for(const wrong of [text.replace("£85","£86"),text.replace("£35","£36"),text.replace("BMPCC 6K Pro","Sony FX3")]) expect(check(wrong,receipts,scope),wrong).not.toEqual([]);
  const wrongDate=receipts.map(receipt=>receipt.call_id==="proposal"?{...receipt,start_date:"2026-12-14",end_date:"2026-12-14"}:receipt);
  expect(check(text,wrongDate,scope)).not.toEqual([]);
 });
});

describe("native component prices followed by their addition total",()=>{
 const scope:StockRequest={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"BMPCC 6K Full Frame",quantity:1}]};
 const added=[{name:"Blazar Remus 100mm",quantity:1},{name:"PL to L mount",quantity:1}];
 const receipts:PriceEvidence[]=[
  {names:["Anamorphic Blazar Remus 100mm"],kind:"rental",days:2,quantity:1,total_gbp:50,daily_rate_gbp:25,source:"hygglo_tier",call_id:"lens"},
  {names:["PL to L mount"],kind:"rental",days:2,quantity:1,total_gbp:20,daily_rate_gbp:10,source:"hygglo_tier",call_id:"adapter"},
  {names:[],kind:"basket",quote_role:"addition",days:2,total_gbp:70,items:added,proposal:{base_items:scope.items,added_items:added},source:"native_lab_proposal",call_id:"basket"}];
 const text="The Great Joy 35mm, 50mm and 85mm anamorphic lens set isn't available for 20 to 21 October.\n\nAs an alternative, we have the Anamorphic Blazar Remus 100mm available at £50 for the 2 days (£25/day). Since the Blazar Remus is PL mount and the Blackmagic 6K Full Frame uses an L-mount, it pairs with our PL to L mount adapter, which is £20 for the 2 days (£10/day)—bringing the addition to £70 total.\n\nI haven't made any changes to your existing booking. Let me know if you'd like to look at adding that setup!";
 it("binds the final amount to the exact previously priced component basket",()=>expect(check(text,receipts,scope)).toEqual([]));
 it("requires every priced component and the exact native basket",()=>{
  for(const wrong of [text.replace("£70","£50"),text.replace("£20","£25"),text.replace("2 days","3 days"),text.replace("PL to L","PL to EF"),text.replace("the Anamorphic Blazar Remus","two Anamorphic Blazar Remus")]) expect(check(wrong,receipts,scope),wrong).not.toEqual([]);
  expect(check(text,receipts.slice(0,2),scope)).not.toEqual([]);
  expect(check(text,[...receipts.slice(0,2),{...receipts[2],proposal:{base_items:[{name:"Sony FX3",quantity:1}],added_items:added}}],scope)).not.toEqual([]);
  expect(check(text,[...receipts.slice(0,2),{...receipts[2],items:[added[0]]}],scope)).not.toEqual([]);
 });
});

it("keeps an existing camera booking in parentheses separate from its multi-component proposal",()=>{
 const scope:StockRequest={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"Blackmagic 6K Full Frame",quantity:1}]};
 const added=[{name:"Blazar Remus 100mm",quantity:1},{name:"PL to L mount",quantity:1}];
 const receipts:PriceEvidence[]=[
 {names:["Blazar Remus 100mm"],kind:"rental",days:2,quantity:1,total_gbp:50,daily_rate_gbp:25,source:"hygglo_tier",call_id:"lens"},
 {names:["PL to L mount"],kind:"rental",days:2,quantity:1,total_gbp:20,daily_rate_gbp:10,source:"hygglo_tier",call_id:"adapter"},
 {names:scope.items.map(i=>i.name),kind:"rental",days:2,quantity:1,total_gbp:124,source:"lab_order_quote",call_id:"base"},
 {names:[],kind:"basket",days:2,total_gbp:194,items:[...scope.items,...added],proposal:{base_items:scope.items,added_items:added},source:"native_lab_proposal",call_id:"proposal"}];
 const text="The Great Joy 35mm, 50mm and 85mm anamorphic lens set isn't available for 20 to 21 October.\n\nAs a compatible anamorphic option, I have the Blazar Remus 100mm T2.8 anamorphic prime (PL mount), which can be paired with our PL to L mount adapter for the Blackmagic 6K Full Frame. For your 2-day dates (20 to 21 October), the Blazar Remus 100mm is £50 (£25/day) and the PL to L mount adapter is £20 (£10/day). Adding that setup to your existing Blackmagic 6K booking (£124) would bring the total to £194.\n\nYour current booking is completely untouched—let me know if you'd like to add the Blazar Remus setup or if you have any questions!";
 expect(check(text,receipts,scope)).toEqual([]);
 for(const wrong of [text.replace("£194","£174"),text.replace("£124","£50"),text.replace("existing Blackmagic 6K booking","existing Sony FX3 booking"),text.replace("2-day dates","3-day dates")]) expect(check(wrong,receipts,scope),wrong).not.toEqual([]);
 expect(check(text,receipts.slice(0,3),scope)).not.toEqual([]);
});

it("binds adding those to the exact preceding bullet group",()=>{
 const scope:StockRequest={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"BMPCC 6K Full Frame",quantity:1}]};
 const added=[{name:"Blazar Remus 100mm",quantity:1},{name:"PL to L mount",quantity:1}];
 const receipts:PriceEvidence[]=[
 {names:[added[0].name],kind:"rental",days:2,quantity:1,total_gbp:50,daily_rate_gbp:25,source:"hygglo_tier",call_id:"lens"},
 {names:[added[1].name],kind:"rental",days:2,quantity:1,total_gbp:20,daily_rate_gbp:10,source:"hygglo_tier",call_id:"adapter"},
 {names:[],kind:"basket",quote_role:"addition",days:2,total_gbp:70,items:added,proposal:{base_items:scope.items,added_items:added},source:"native_lab_proposal",call_id:"addition"}];
 const text="- Blazar Remus 100mm: £25/day (£50 total)\n- PL to L mount adapter: £10/day (£20 total)\n\nAdding those would be £70.";
 expect(check(text,receipts,scope)).toEqual([]);
 expect(check(text.replace("£70","£50"),receipts,scope)).not.toEqual([]);
 expect(check(text,receipts.slice(0,2),scope)).not.toEqual([]);
});

describe("prices in compatibility relative clauses",()=>{
 const scope:StockRequest={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"BMPCC 6K Full Frame",quantity:1}]};
 const receipts:PriceEvidence[]=[
 {names:["Blazar Remus 100mm"],kind:"rental",days:2,quantity:1,total_gbp:50,daily_rate_gbp:25,source:"hygglo_tier",call_id:"lens"},
 {names:["PL to L mount"],kind:"rental",days:2,quantity:1,total_gbp:20,daily_rate_gbp:10,source:"hygglo_tier",call_id:"adapter"}];
 const text="The Great Joy 35mm, 50mm, and 85mm anamorphic lens set isn't available for 20 to 21 October. \n\nFor an anamorphic option on the Blackmagic 6K Full Frame (native L-mount), I have the Blazar Remus 100mm T2.8 anamorphic prime available. That runs at £25/day (£50 total for your 2-day shoot). Since it's PL mount, it pairs with our PL to L-mount adapter, which is £10/day (£20 total for 2 days).\n\nI haven't changed anything on your current booking. Let me know if you'd like to look at adding the Blazar Remus setup!";
 it("prices the relative-clause adapter separately from the lens",()=>{
  expect(check(text,receipts,scope)).toEqual([]);
  for(const verb of ["works","can be paired","can be used"]) expect(check(text.replace("pairs",verb),receipts,scope),verb).toEqual([]);
 });
 it("cannot borrow a price for another item, quantity, duration or amount",()=>{
  for(const wrong of [text.replace("£10","£25"),text.replace("£20","£50"),text.replace("PL to L-mount","PL to EF mount"),text.replace("PL to L-mount adapter","two PL to L-mount adapters"),text.replace("PL to L-mount adapter","unknown cinema accessory"),text.replace("2 days","3 days")]) expect(check(wrong,receipts,scope),wrong).not.toEqual([]);
  expect(check(text,receipts.slice(0,1),scope)).not.toEqual([]);
 });
});

describe("replacement quote identity and full basket scope",()=>{
 const old="TTArtisan 11mm f2.8 Fisheye (Sony E)",next="Sony GM 16-35mm f2.8";
 const scope:StockRequest={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:old,quantity:1}]};
 const lines:PriceEvidence[]=[{names:[old],kind:"rental",days:2,quantity:1,total_gbp:42,daily_rate_gbp:21,call_id:"old",source:"lab_order_quote"},{names:[next],kind:"rental",days:2,quantity:1,total_gbp:40,daily_rate_gbp:20,call_id:"alternative",source:"hygglo_tier"}];
 const proposal:PriceEvidence={names:[],kind:"basket",days:2,total_gbp:40,call_id:"native-replacement",source:"native_lab_proposal",items:[{name:next,quantity:1}],proposal:{base_items:scope.items,removed_items:scope.items,added_items:[{name:next,quantity:1}]}};
 const text="Sony GM 16-35mm f2.8 is £40 for the 2 days (£20/day). If you'd like to swap out the TTArtisan (£42), the updated booking total would be £40.";
 it("requires a complete replacement receipt instead of deriving the booking total from an item price",()=>{
  expect(unsupportedPriceClaims(text,[...lines,proposal],scope)).toEqual([]);
  expect(unsupportedPriceClaims("Swapping the TTArtisan for Sony GM 16-35mm f2.8 would bring your booking total to £40.",[...lines,proposal],scope)).toEqual([]);
  const failure=unsupportedPriceClaims(text,lines,scope);
  expect(failure).toHaveLength(1);
  expect(failure[0]).toContain("£40");
 });
 it("rejects unknown and ambiguous parenthesized models rather than borrowing the prior offer",()=>{
  expect(unsupportedPriceClaims(text.replace("the TTArtisan (","the TTArtisan 50mm ("),[...lines,proposal],scope)).not.toEqual([]);
  expect(unsupportedPriceClaims(text,[...lines,{...lines[0],names:["TTArtisan 50mm f2"],call_id:"another-tt"},proposal],scope)).not.toEqual([]);
  expect(unsupportedPriceClaims(text.replace("TTArtisan (£42)","TTArtisan (£40)"),[...lines,proposal],scope)).not.toEqual([]);
 });
 it("keeps exact basket members, base context, dates and quantities binding",()=>{
  for(const changed of [{...proposal,total_gbp:41},{...proposal,start_date:"2026-10-22"},{...proposal,items:[{name:old,quantity:1}]},{...proposal,proposal:{...proposal.proposal!,base_items:[{name:"Sony FX3",quantity:1}]}},{...proposal,proposal:{...proposal.proposal!,added_items:[{name:next,quantity:2}]}}])
   expect(unsupportedPriceClaims(text,[...lines,changed],scope)).not.toEqual([]);
 });
});

it("resolves prime focal references from Native lens identities without borrowing another mount or brand",()=>{
 const scope:StockRequest={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"Sony FX3",quantity:1}]};
 const lens:PriceEvidence={names:["TTArtisan 11mm f2.8 Fisheye (Sony E)"],kind:"rental",days:2,quantity:1,total_gbp:42,call_id:"native-prime",source:"hygglo_tier"};
 expect(unsupportedPriceClaims("TTArtisan 11mm is £42 for the two days.",[lens],scope)).toEqual([]);
 expect(unsupportedPriceClaims("11mm is £42 for the two days.",[lens],scope)).toEqual([]);
 expect(unsupportedPriceClaims("Laowa 11mm is £42 for the two days.",[lens],scope)).not.toEqual([]);
 expect(unsupportedPriceClaims("TTArtisan RF 11mm is £42 for the two days.",[lens],scope)).not.toEqual([]);
 expect(unsupportedPriceClaims("11mm is £42 for the two days.",[lens,{...lens,names:["Laowa 11mm f4"],call_id:"another-prime"}],scope)).not.toEqual([]);
});

describe("Native replacement price differences", () => {
 const request={items:[{name:"TTArtisan 11mm f2.8",quantity:1}],start_date:"2026-10-20",end_date:"2026-10-21"};
 const added={name:"Sony GM 16-35mm f2.8",quantity:1};
 const receipt:PriceEvidence={names:[],kind:"basket",items:[added],days:2,start_date:request.start_date,end_date:request.end_date,total_gbp:40,source:"native_lab_proposal",call_id:"actual-swap",proposal:{base_items:request.items,added_items:[added],removed_items:request.items,base_total_gbp:42}};
 const reply="Swapping the TTArtisan 11mm for the Sony GM 16-35mm f2.8 would bring your total to £40, a saving of £2.";
 it("validates the difference independently of the complete rental total",()=>{
  expect(unsupportedPriceClaims(reply,[receipt],request)).toEqual([]);
  expect(unsupportedPriceClaims(reply.replace("saving of £2","saving of £3"),[receipt],request)).toHaveLength(1);
  expect(unsupportedPriceClaims(reply.replace("saving of £2","£2 extra"),[receipt],request)).toHaveLength(1);
  expect(unsupportedPriceClaims(reply.replace("£40","£45").replace("saving of £2","£3 extra"),[{...receipt,total_gbp:45}],request)).toEqual([]);
 });
 it("retains the named lens across a separate booking-total sentence",()=>{
  const text="I can swap the TTArtisan 11mm for the Sony GM 16-35mm f2.8. Your updated booking total would be £40, a saving of £2. Shall I make that swap?";
  expect(unsupportedPriceClaims(text,[receipt],request)).toEqual([]);
  expect(unsupportedPriceClaims(text.replace("Sony GM 16-35mm f2.8","Laowa 16-35mm f2.8"),[receipt],request).length).toBeGreaterThan(0);
 });
 it("allows a post-amendment saving with the same Native resulting basket",()=>{
  expect(unsupportedPriceClaims("The Sony GM 16-35mm f2.8 is now in your basket, a saving of £2.",[receipt],{...request,items:[added]})).toEqual([]);
 });
 it("does not use an ordinary lens price to prove a saving",()=>{
  const lens:PriceEvidence={names:[added.name],kind:"rental",days:2,quantity:1,start_date:request.start_date,end_date:request.end_date,total_gbp:2,source:"hygglo_tier",call_id:"unrelated-item-price"};
  const failures=unsupportedPriceClaims(reply,[lens],request);
  expect(failures.some(f=>f.includes("£2"))).toBe(true);
 });
 it("requires unchanged scope, both basket sides and an actual base total",()=>{
  for(const changed of [{...receipt,proposal:{...receipt.proposal!,base_total_gbp:undefined}},{...receipt,proposal:{...receipt.proposal!,base_items:[{name:"Sony FX3",quantity:1}]}},{...receipt,proposal:{...receipt.proposal!,removed_items:[{name:request.items[0].name,quantity:2}]}},{...receipt,items:[{...added,quantity:2}]},{...receipt,start_date:"2026-10-22"},{...receipt,days:3}])expect(unsupportedPriceClaims(reply,[changed],request).length).toBeGreaterThan(0);
  expect(unsupportedPriceClaims(reply,[receipt],{...request,items:[{name:"Sony FX3",quantity:1}]}).length).toBeGreaterThan(0);
 });
 it("does not relabel a price difference as a discount, refund or daily rate",()=>{
  for(const changed of [reply.replace("saving","discount"),reply.replace("saving","refund"),reply.replace("£2.","£2/day.")])expect(unsupportedPriceClaims(changed,[receipt],request).length).toBeGreaterThan(0);
 });
});

describe("item caption and renter budget identity",()=>{
 const scope={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"Canon R5",quantity:1}]};
 const proof:PriceEvidence[]=[{names:["Sony A7 V"],kind:"rental",total_gbp:84,daily_rate_gbp:42,days:2,quantity:1,start_date:scope.start_date,end_date:scope.end_date,call_id:"native",source:"hygglo_tier"}];
 it("keeps a caption's known model while preserving wrong variants and extra features",()=>{
  expect(unsupportedPriceClaims("Sony A7 V body (£84 for 2 days).",proof,scope)).toEqual([]);
  for(const name of ["Sony A7 IV body","Sony A7 V Pro body","Sony A7 V autofocus lens","Sony A7 V + microphone body"])expect(unsupportedPriceClaims(`${name} (£84 for 2 days).`,proof,scope),name).not.toEqual([]);
 });
 it("grounds a budget reference to the actual current renter message",()=>{
  const text="This fits right inside your £150 budget.";
  expect(unsupportedPriceClaims(text,[],scope,"My budget is £150 total for those two days.")).toEqual([]);
  for(const latest of ["","My budget is £120.","Your rental costs £150."])expect(unsupportedPriceClaims(text,[],scope,latest)).not.toEqual([]);
  for(const changed of ["The total is £150.","The total is your £150 budget.","This fits inside your £150 budget rate."])expect(unsupportedPriceClaims(changed,[],scope,"My budget is £150.")).not.toEqual([]);
 });
});

const calendarPrices = calendarRateFixture.prices as PriceEvidence[];
const calendarRequest = calendarRateFixture.request as StockRequest;
const calendarCheck = (text: string, receipts = calendarPrices) => unsupportedPriceClaims(text, receipts, calendarRequest);
describe("Native calendar-qualified total followed by a parenthesized daily rate", () => {
  it("keeps the actual equipment subject in the captured Lab reply", () => {
    expect(calendarCheck(calendarRateFixture.text)).toEqual([]);
  });
  it("still rejects incorrect totals, daily rates, duration and quantity", () => {
    expect(calendarCheck(calendarRateFixture.text.replace("£70", "£75"))).not.toEqual([]);
    expect(calendarCheck(calendarRateFixture.text.replace("£35/day", "£30/day"))).not.toEqual([]);
    expect(calendarCheck(calendarRateFixture.text.replace("20–21 October", "20–22 October"))).not.toEqual([]);
    expect(calendarCheck(calendarRateFixture.text, calendarPrices.map(p => ({ ...p, quantity: 2 })))).not.toEqual([]);
  });
  it("does not discard equipment words in a calendar-qualified label", () => {
    expect(calendarCheck(calendarRateFixture.text.replace("total for 20–21 October", "total for Pyxis for 20–21 October"))).not.toEqual([]);
  });
  it("requires a Native receipt for the recommended body", () => {
    expect(calendarCheck(calendarRateFixture.text, calendarPrices.filter(p => !p.names.some(n => /6k pro/i.test(n))))).not.toEqual([]);
  });
});
