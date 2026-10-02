import {describe,it,expect} from "vitest";
import {unsupportedPriceClaims,type PriceEvidence} from "./price_claims";
import {guardDraft} from "./draft_guard";
import type {StockRequest} from "./stock_claims";
const request:StockRequest={start_date:"2026-10-02",end_date:"2026-10-04",items:[{name:"BMPCC 6K Full Frame",quantity:1}]};
const prices:PriceEvidence[]=[{names:["BMPCC 6K Pro"],kind:"rental",days:3,quantity:1,daily_rate_gbp:30,base_rate_gbp:35,total_gbp:90,start_date:"2026-10-02",end_date:"2026-10-04",call_id:"real-alt",source:"hygglo_tier"},
{names:["BMPCC 6K Full Frame"],kind:"rental",days:3,quantity:1,daily_rate_gbp:43.33,base_rate_gbp:50,total_gbp:130,call_id:"selected",source:"hygglo_tier"}];
const check=(text:string, evidence=prices,scope=request)=>unsupportedPriceClaims(text,evidence,scope);
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
