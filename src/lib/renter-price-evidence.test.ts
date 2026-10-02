import {describe,it,expect} from "vitest";
import {renterPriceEvidence} from "./renter-price-evidence";
import type {ToolReceipt} from "./renter-tool-evidence";
const receipt=(tool:string,result:Record<string,unknown>,call_id="call"):ToolReceipt=>({tool,result,call_id});
describe("server price receipt adapters",()=>{
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
