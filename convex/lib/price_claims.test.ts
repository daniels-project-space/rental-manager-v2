import {describe,it,expect} from "vitest";
import {unsupportedPriceClaims,type PriceEvidence} from "./price_claims";
import {guardDraft} from "./draft_guard";
import type {StockRequest} from "./stock_claims";
const request:StockRequest={start_date:"2026-10-02",end_date:"2026-10-04",items:[{name:"BMPCC 6K Full Frame",quantity:1}]};
const prices:PriceEvidence[]=[{names:["BMPCC 6K Pro"],kind:"rental",days:3,quantity:1,daily_rate_gbp:30,base_rate_gbp:35,total_gbp:90,start_date:"2026-10-02",end_date:"2026-10-04",call_id:"real-alt",source:"hygglo_tier"},
{names:["BMPCC 6K Full Frame"],kind:"rental",days:3,quantity:1,daily_rate_gbp:43.33,base_rate_gbp:50,total_gbp:130,call_id:"selected",source:"hygglo_tier"}];
const check=(text:string, evidence=prices,scope=request)=>unsupportedPriceClaims(text,evidence,scope);
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
