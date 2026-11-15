import {describe,it,expect} from "vitest";
import fixture from "../../src/lib/fixtures/renter-swap-comparison.json";
import {replacementQuoteFallback} from "./replacement_quote_fallback";
import {guardDraft} from "./draft_guard";
import type {PriceEvidence} from "./price_claims";
import type {StockRequest} from "./stock_claims";
const input={message:"Can I swap the Blackmagic for the Sony A7 III and what would the total be?",prices:fixture.evidence as PriceEvidence[],contextKey:"context",epoch:0,messageId:"message"};
describe("rendering a verified replacement quote after an unsafe draft",()=>{
 it("uses the one exact Native replacement and passes the normal guard",()=>{
  const result=replacementQuoteFallback(input);expect(result?.text).toContain("£18");expect(result?.text).toContain("BMPCC 6K Full Frame");
  const checked=guardDraft(result!.text,{history:[],lastRenterMessage:input.message,account:"dbcinema",stage:"AWAITING_OWNER_APPROVAL",ownerApproved:false,hasItemGrounding:true,priceEvidence:input.prices,priceRequest:fixture.request as StockRequest,stockRequest:fixture.request as StockRequest});
  expect(checked.flags.filter(f=>f.severity==="critical"&&f.action==="flagged")).toEqual([]);
 });
 it.each(["Can I swap for the Sony A7 III and what is the delivery price?","What is the total for a Sony FX3 swap?","Can I swap for the Sony A7 III and does it include a lens?"])("does not omit a different or extra request: %s",message=>expect(replacementQuoteFallback({...input,message})).toBeNull());
 it("requires Native replacement evidence",()=>expect(replacementQuoteFallback({...input,prices:input.prices.filter(p=>!p.proposal?.removed_items)})).toBeNull());
});
