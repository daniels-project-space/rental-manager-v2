import { describe, expect, it } from "vitest";
import fixture from "../../src/lib/fixtures/renter-committed-addition.json";
import prices from "../../src/lib/fixtures/renter-updated-setup-guard.json";
import { committedAdditionConfirmation } from "./amendment_confirmation";
import { guardDraft } from "./draft_guard";
import type { DraftContextTransition } from "./draft_review";
import type { PriceEvidence } from "./price_claims";

const input = () => ({...structuredClone(fixture.input),transitions:structuredClone(fixture.input.transitions) as DraftContextTransition[]});
describe("stored addition confirmation recovery", () => {
  it("confirms the actual committed Native addition with current dates and total", () => {
    expect(committedAdditionConfirmation(input())).toBe("I've added 1x Blazar Remus 100mm and 1x PL → L adapter to your booking for 20 October 2026 to 21 October 2026. The updated booking total is £194.");
  });
  it("passes the complete guard using the captured actual post-amendment Native prices", () => {
    const text=committedAdditionConfirmation(input())!;
    const g=guardDraft(text,{history:[],lastRenterMessage:"Yes, please add both.",account:"leo",stage:"CONFIRMED_UPCOMING",
      ownerApproved:true,bookingModified:true,hasItemGrounding:true,
      priceEvidence:prices.priceEvidence as PriceEvidence[],priceRequest:prices.priceRequest,
      stockRequest:prices.stockRequest});
    expect(g.flags.filter(f=>f.severity==="critical" && f.action==="flagged")).toEqual([]);
    expect(g.text).toContain("£194");
  });
  const cases: Array<[string,(i:ReturnType<typeof input>)=>void]> = [
    ["real chat",i=>{i.threadId="real-chat";}],
    ["different account",i=>{i.account="diogo";}],
    ["later renter message",i=>{i.messageId+="later";}],
    ["stale context",i=>{i.afterKey+="changed";}],
    ["no transition",i=>{i.transitions=[];}],
    ["multiple writes",i=>{i.transitions.push(i.transitions[0]);}],
    ["no new edit / idempotent retry",i=>{i.after=structuredClone(i.before) as typeof i.after;}],
    ["wrong revision",i=>{i.transitions[0].after_revision++;}],
    ["different dates",i=>{i.after.end_date="2026-10-22";}],
    ["cancelled booking",i=>{i.after.stage="CANCELLED";}],
    ["missing Native price",i=>{i.after.total_gbp=NaN;}],
    ["grand total inconsistent",i=>{i.after.total_gbp=195;}],
    ["base item removed",i=>{i.after.lines=i.after.lines.slice(1);i.after.total_gbp=70;}],
    ["existing price changed",i=>{i.after.lines[0].line_total_gbp=125;i.after.total_gbp=195;}],
    ["extra unrequested quantity",i=>{i.after.lines[1].qty++;}],
    ["unrelated request key",i=>{i.after.changes[0].request_key=JSON.stringify([i.messageId,"remove_item",1116294]);}],
    ["unknown Native listing",i=>{i.after.lines[1].product_id=999;}],
    ["invalid ISO date",i=>{i.before.start_date=i.after.start_date="2026-02-30";}],
  ];
  it.each(cases)("retains human review for %s",(_,change)=>{const i=input();change(i);expect(committedAdditionConfirmation(i)).toBeNull();});
});

import dateFixture from "../../src/lib/fixtures/renter-committed-date.json";
import removalFixture from "../../src/lib/fixtures/renter-committed-removal.json";
import { committedAmendmentConfirmation } from "./amendment_confirmation";
const dateInput=()=>({...structuredClone(dateFixture.input),transitions:structuredClone(dateFixture.input.transitions) as DraftContextTransition[]});
const removalInput=()=>({...structuredClone(removalFixture.input),transitions:structuredClone(removalFixture.input.transitions) as DraftContextTransition[]});
describe("Native date and removal failure recovery",()=>{
 it("confirms the actual date edit with raw-tier £170 and independent Native prices",()=>{
  const result=committedAmendmentConfirmation(dateInput());
  expect(result).toMatchObject({action:"set_dates",text:"I've updated your booking dates to 20 October 2026 to 22 October 2026. The updated booking total is £170."});
  expect(result?.prices[0]).toMatchObject({total_gbp:170,days:3});expect(result?.prices[1]).toMatchObject({daily_rate_gbp:56.67,total_gbp:170});
 });
 it("confirms the actual removal while retaining the booked camera and adapter",()=>{
  const result=committedAmendmentConfirmation(removalInput());
  expect(result?.action).toBe("remove_item");expect(result?.text).toContain("1x Blazar Remus 100mm");expect(result?.text).toContain("£144");
  expect(result?.request.items).toHaveLength(2);
 });
 for(const makeInput of [input,dateInput,removalInput]){
  it("passes the normal guard with independently reconstructed Native prices",()=>{
   const result=committedAmendmentConfirmation(makeInput())!;expect(result).not.toBeNull();
   const guard=guardDraft(result.text,{history:[],lastRenterMessage:"Please update my booking.",account:"leo",stage:"CONFIRMED_UPCOMING",ownerApproved:true,bookingModified:true,hasItemGrounding:true,priceEvidence:result.prices,priceRequest:result.request,stockRequest:result.request});
   expect(guard.flags.filter(f=>f.severity==="critical"&&f.action==="flagged")).toEqual([]);
  });
 }
 for(const [label,mutate] of [
  ["wrong target date",(i:any)=>i.after.changes.at(-1).request_key=JSON.stringify([i.messageId,"set_dates","2026-10-20","2026-10-23"])],
  ["changed basket",(i:any)=>i.after.lines[0].qty++],
  ["changed raw rate",(i:any)=>i.after.lines[0].daily_price_gbp++],
  ["changed captured tiers",(i:any)=>i.after.lines[0].price_tiers[0].pricePerDay++],
  ["unpriced receipt",(i:any)=>delete i.after.lines[0].daily_price_gbp],
  ["approximate-rate multiplication",(i:any)=>{i.after.total_gbp=170.01;i.after.lines[0].line_total_gbp=170.01;}],
  ["unrelated message",(i:any)=>i.messageId+="-new"],
  ["stale after context",(i:any)=>i.afterKey+="changed"],
  ["multiple edits",(i:any)=>i.transitions.push(i.transitions[0])],
  ["no edit",(i:any)=>i.after=structuredClone(i.before)],
 ] as const){it(`retains review for ${label}`,()=>{const i=dateInput();mutate(i);expect(committedAmendmentConfirmation(i)).toBeNull();});}
 for(const [label,mutate] of [
  ["wrong removed product",(i:any)=>i.after.changes.at(-1).removed_item.product_id=999],
  ["wrong removed quantity",(i:any)=>i.after.changes.at(-1).removed_item.qty=2],
  ["wrong removal request key",(i:any)=>i.after.changes.at(-1).request_key=JSON.stringify([i.messageId,"remove_item","product:999",1])],
  ["extra quantity change",(i:any)=>i.after.lines[0].qty++],
  ["price changed on retained line",(i:any)=>i.after.lines[0].daily_price_gbp++],
  ["whole booking removed",(i:any)=>{i.after.lines=[];i.after.total_gbp=0;}],
 ] as const){it(`retains removal review for ${label}`,()=>{const i=removalInput();mutate(i);expect(committedAmendmentConfirmation(i)).toBeNull();});}
});
