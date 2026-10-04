import {describe,it,expect} from "vitest";
import {nativeInquiryQuote,renderNativeQuoteReply} from "./renter-native-quote";
import {renterPriceEvidence} from "./renter-price-evidence";
import {renterToolReceipts,stockReceipts} from "./renter-tool-evidence";
import {unsupportedPriceClaims} from "../../convex/lib/price_claims";
import {validateRenterBotOutput,type RenterBotOutput} from "./renter-bot-output";
import fixtures from "./fixtures/renter-native-quotes.json";
const scope={threadId:fixtures.first.thread_id,accountSlug:"leo",requestMessageId:"renter-1",rentalStage:"INQUIRY",queryRevision:()=>0};
const receipt=(result=fixtures.first,context=scope)=>({tool:"check_basket_availability",call_id:"real-native",result:{...result,renter_quote:nativeInquiryQuote(result,context)}});
const base:RenterBotOutput={draft:"",intent:"EQUIPMENT_QUESTION",conversation_stage:"INQUIRY",needs_human:false,red_flags:[],factsClaimed:[]};
const clone=()=>structuredClone(fixtures.first);
const parts=(key=nativeInquiryQuote(fixtures.first,scope)!.quote_key):RenterBotOutput=>({...base,reply_parts:[{type:"text",text:"The R5 kit isn't available, but I can offer this Sony setup:"},{type:"quote",quote_key:key},{type:"text",text:"Would this work for your shoot?"}]});
describe("Native inquiry quote rendering",()=>{
 it("renders the selected real Native basket without trusting model amounts or names",()=>{
  const quote=nativeInquiryQuote(fixtures.first,scope)!;expect(quote).not.toBeNull();
  expect(quote.display_text).toContain("1 × Sony FX3: £98");expect(quote.display_text).toContain("Total: £138");
  expect(quote.display_text).toContain("20 October 2026 to 21 October 2026");
  const output=validateRenterBotOutput(parts())!;expect(output).not.toBeNull();
  const rendered=renderNativeQuoteReply(output,[receipt()],scope);expect(rendered.ok).toBe(true);
  if(rendered.ok){expect(rendered.draft).not.toContain(quote.quote_key);expect(rendered.draft).toContain(quote.display_text);
   const request={start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"Canon R5",quantity:1}]};
   expect(unsupportedPriceClaims(rendered.draft,renterPriceEvidence([receipt()],[],scope.threadId),request)).toEqual([]);
  }
 });
 it("checks separate alternatives independently rather than manufacturing a combined offer",()=>{
  const first=nativeInquiryQuote(fixtures.first,scope)!,second=nativeInquiryQuote(fixtures.second,scope)!;
  const rendered=renderNativeQuoteReply({...base,reply_parts:[{type:"quote",quote_key:first.quote_key},{type:"quote",quote_key:second.quote_key}]},[receipt(),receipt(fixtures.second)],scope);
  expect(first.quote_key).not.toBe(second.quote_key);expect(rendered.ok).toBe(true);
  if(rendered.ok){expect(rendered.draft).toContain("Total: £138");expect(rendered.draft).toContain("Total: £124");expect(rendered.draft).not.toContain("£262");}
 });
 it("retains the quote descriptor through real tool receipt harvesting",()=>{
  const quote=nativeInquiryQuote(fixtures.first,scope)!;
  const receipts=renterToolReceipts([{toolName:"check_basket_availability",toolCallId:"native",result:{...fixtures.first,renter_quote:quote}}]);
  expect(renderNativeQuoteReply(parts(quote.quote_key),receipts,scope).ok).toBe(true);expect(stockReceipts(receipts).length).toBeGreaterThan(0);
 });
 it("rejects unknown, duplicated, stale, foreign and unverified quote selections",()=>{
  const key=nativeInquiryQuote(fixtures.first,scope)!.quote_key;
  expect(renderNativeQuoteReply(parts("inquiry_"+"0".repeat(32)),[receipt()],scope).ok).toBe(false);
  expect(renderNativeQuoteReply({...base,reply_parts:[{type:"quote",quote_key:key},{type:"quote",quote_key:key}]},[receipt()],scope).ok).toBe(false);
  for(const changed of [{...scope,threadId:"other"},{...scope,accountSlug:"diogo"},{...scope,requestMessageId:"renter-2"},{...scope,rentalStage:"CONFIRMED_UPCOMING"},{...scope,queryRevision:()=>2}])expect(renderNativeQuoteReply(parts(key),[receipt()],changed).ok).toBe(false);
  expect(renderNativeQuoteReply(parts(key),[],scope).ok).toBe(false);
 });
 it("accepts a freshly rechecked quote after an action but never a pre-write receipt",()=>{
  const next={...scope,queryRevision:()=>2};
  const quote=nativeInquiryQuote(fixtures.first,next)!;
  expect(quote.quote_key).not.toBe(nativeInquiryQuote(fixtures.first,scope)!.quote_key);
  expect(nativeInquiryQuote(fixtures.first,next,0)).toBeNull();
  expect(renderNativeQuoteReply(parts(quote.quote_key),[receipt(fixtures.first,next)],next).ok).toBe(true);
  expect(renderNativeQuoteReply(parts(quote.quote_key),[receipt()],next).ok).toBe(false);
 });
 it("does not issue a descriptor for inconsistent physical identities, quantities, prices or dates",()=>{
  const wrongName=clone();wrongName.quote.lines[0].name="Sony FX30";
  const price=clone();price.quote.lines[0].line_total_gbp=97;
  const total=clone();total.quote.total_gbp=139;
  const qty=clone();qty.quote.lines[0].qty=2;
  const dates=clone();dates.quote.start_date="2026-10-22";
  const physical=clone();physical.components[0].requested_units=2;
  const stock=clone();stock.components[0].available=false;
  const free=clone();free.components[0].free_units=0;
  const marketing=clone();marketing.components[0].is_marketing_only=true;
  const owned=clone();owned.components[0].owned=false;
  const unpriced=clone();unpriced.quote.unpriced.push("Missing price" as never);
  for(const result of [wrongName,price,total,qty,dates,physical,stock,free,marketing,owned,unpriced])expect(nativeInquiryQuote(result,scope)).toBeNull();
 });
 it("holds hand-written money or a second draft while retaining ordinary nonquote replies",()=>{
  for(const text of ["It costs £139","It costs 139 GBP","It costs 139 pounds","It costs €139","The total is 139","The price is 139"])
   expect(renderNativeQuoteReply({...parts(),reply_parts:[{type:"text",text},...parts().reply_parts!.slice(1)]},[receipt()],scope).ok).toBe(false);
  expect(renderNativeQuoteReply({...parts(),draft:"Another reply"},[receipt()],scope).ok).toBe(false);
  expect(renderNativeQuoteReply({...base,draft:"The total is £138."},[receipt()],scope).ok).toBe(false);
  expect(renderNativeQuoteReply({...base,draft:"Yes, that lens is already included."},[receipt()],scope)).toEqual({ok:true,draft:"Yes, that lens is already included.",quote_keys:[]});
  expect(renderNativeQuoteReply({...base,needs_human:true},[receipt()],scope)).toEqual({ok:true,draft:"",quote_keys:[]});
 });
});
