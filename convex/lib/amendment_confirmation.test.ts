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
