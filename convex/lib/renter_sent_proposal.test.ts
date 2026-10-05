import {sentInquiryOffers} from "./sent_inquiry_offer";
import {sentBookingProposals} from "./renter_sent_proposal";
import { REFERRAL_RESTORE_OFFER } from "./referral_offer";
import { describe, expect, it } from "vitest";
import { additionProposalsFromEvidence, sentAdditionProposals } from "./renter_sent_proposal";
import { draftContextKey } from "./draft_review";
import { renterPriceEvidence } from "../../src/lib/renter-price-evidence";
import nativeQuote from "../../src/lib/fixtures/renter-joint-native-quote.json";
import { recordSentReply } from "../replyInbox";
import { appendAssistantMessage } from "../renter_bot_lab_actions";
import type { PriceEvidence } from "./price_claims";

const scope={context_key:"current-basket",epoch:5,message_id:"renter-current"};
const price=():PriceEvidence=>({names:[],kind:"basket",source:"native_lab_proposal",call_id:"quote",total_gbp:194,start_date:"2026-10-20",end_date:"2026-10-21",
  proposal:{physical_identity_key:"native-addition-key",base_items:[{name:"BMPCC 6K Full Frame",quantity:1}],added_items:[{name:"Remus 100mm",quantity:1},{name:"PL to L mount",quantity:1}],
    added_listings:[{product_id:1116294,quantity:1},{product_id:1172765,quantity:1}],additional_cost_gbp:70}});

describe("sent Native proposal evidence",()=>{
  it("retains exact Native listing identity and marginal terms from the real joint quote fixture",()=>{
    const evidence=renterPriceEvidence([{tool:"quote_booking_addition",call_id:"native",result:{...nativeQuote,physical_identity_key:"native-addition-key"}}],[],nativeQuote.thread_id);
    const proposals=additionProposalsFromEvidence(evidence,scope);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({items:[{product_id:1116294,qty:1},{product_id:1172765,qty:1}],total_gbp:194,additional_cost_gbp:70,physical_identity_key:"native-addition-key"});
  });
  it("does not duplicate the quote for a grouped marginal price receipt",()=>{
    expect(additionProposalsFromEvidence([price(),{...price(),quote_role:"addition"},price()],scope)).toHaveLength(1);
  });
  for(const variant of ["wrong_marginal","missing_native_id","wrong_thread"]){
    it(`does not promote ${variant} from the Native receipt into an archived proposal`,()=>{
      const quote=structuredClone(nativeQuote);
      if(variant==="wrong_marginal")quote.additional_cost_gbp+=1;
      if(variant==="missing_native_id")delete (quote.addition_quote.lines[0] as any).product_id;
      const evidence=renterPriceEvidence([{tool:"quote_booking_addition",call_id:"native",result:quote}],[],variant==="wrong_thread"?"__probe__other":quote.thread_id);
      expect(additionProposalsFromEvidence(evidence,scope)).toEqual([]);
    });
  }
  for(const variant of ["wrong_source","no_ids","zero_id","fractional_quantity","duplicate_ids","no_marginal","excess_marginal","missing_dates"]){
    it(`does not archive ${variant}`,()=>{
      const p=price();
      if(variant==="wrong_source")p.source="lab_order_quote";
      if(variant==="no_ids")delete p.proposal!.added_listings;
      if(variant==="zero_id")p.proposal!.added_listings![0].product_id=0;
      if(variant==="fractional_quantity")p.proposal!.added_listings![0].quantity=1.5;
      if(variant==="duplicate_ids")p.proposal!.added_listings![1].product_id=p.proposal!.added_listings![0].product_id;
      if(variant==="no_marginal")delete p.proposal!.additional_cost_gbp;
      if(variant==="excess_marginal")p.proposal!.additional_cost_gbp=300;
      if(variant==="missing_dates")delete p.start_date;
      expect(additionProposalsFromEvidence([p],scope)).toEqual([]);
    });
  }
});

function fixture(){
  const thread="__probe__sent-proposal";
  const order={_id:"order",thread_id:thread,account_slug:"leo",start_date:"2026-10-20",end_date:"2026-10-21",items:[{name:"BMPCC 6K Full Frame",qty:1,daily_price_gbp:62,pricing_basis:"listing" as const,origin:"seed" as const}],changes:[]};
  const context=draftContextKey(null,undefined,order);
  const conversation:any={_id:"conversation",thread_id:thread,account_slug:"leo",ai_draft_text:"The lens and adapter cost £70 extra. Shall I add both?",ai_draft_for_message_id:"renter-current",ai_draft_context_key:context,ai_draft_epoch:5,ai_draft_generated_at:10,
    ai_draft_evidence:{model_id:"test-only",stage:"CONFIRMED_UPCOMING",prices:[price()],stock:[]}};
  const tables:Record<string,any[]>={renter_bot_lab_orders:[order],conversations:[conversation],settings:[{draft_epoch:5}],hygglo_messages:[{_id:"renter",thread_id:thread,account_slug:"leo",message_id:"renter-current",sender:"renter",body_text:"What is the complete price?",fetched_at:1,hygglo_sent_at:1}]};
  const db:any={query:(table:string)=>{const filters:Array<[string,any]>=[];const q={eq:(k:string,v:any)=>{filters.push([k,v]);return q;}};const r:any={withIndex:(_:string,f:any)=>{f(q);return r;},collect:async()=> (tables[table]??[]).filter(i=>filters.every(([k,v])=>i[k]===v)),first:async()=> (await r.collect())[0]??null,unique:async()=> (await r.collect())[0]??null};return r;},
    insert:async(table:string,value:any)=>{(tables[table]??=[]).push({_id:`insert-${tables[table].length}`, ...value});},patch:async(id:string,value:any)=>{Object.assign(Object.values(tables).flat().find(i=>i._id===id),value);}};
  return {thread,conversation,tables,ctx:{db,scheduler:{runAfter:async()=>null}} as any};
}

describe("owner message proposal archive",()=>{
 it("archives only an actually displayed explicit Native referral action for an empty inquiry",async()=>{
  const f=fixture(),order=f.tables.renter_bot_lab_orders[0];order.items=[];order.changes=[];
  f.conversation.ai_draft_context_key=draftContextKey(null,undefined,order);
  const text="For 2 days (20 October 2026 to 21 October 2026):\n- 1 × Sony FX3: £98\nTotal: £98\n\n"+REFERRAL_RESTORE_OFFER;
  f.conversation.ai_draft_text=text;f.conversation.ai_draft_evidence={model_id:"native",stage:"INQUIRY",stock:[],stock_quotes:[{quote_key:"selected",referral_code:"ref-code",offer_text:text,start_date:"2026-10-20",end_date:"2026-10-21",items:[{item_id:"fx3",name:"Sony FX3",quantity:1}],listing_quote:{total_gbp:98,lines:[{product_id:123,name:"Sony FX3",quantity:1,total_gbp:98}]}}]};
  expect(await sentAdditionProposals(f.ctx,f.conversation,text)).toMatchObject([{referral_code:"ref-code",base_items:[],items:[{product_id:123,qty:1}],total_gbp:98,additional_cost_gbp:98}]);
  expect(await sentAdditionProposals(f.ctx,f.conversation,"Thanks!\n\n"+text+"\nLet me know.")).toHaveLength(1);
  expect(await sentAdditionProposals(f.ctx,f.conversation,text.replaceAll("£98","£90"))).toEqual([]);
  f.conversation.ai_draft_text=text.replace(REFERRAL_RESTORE_OFFER,"");expect(await sentAdditionProposals(f.ctx,f.conversation,f.conversation.ai_draft_text)).toEqual([]);
 });

  for(const path of ["lab","owner"]){
    it(`${path} attaches the exact approved quote before clearing or rotating its draft`,async()=>{
      const f=fixture();const text=f.conversation.ai_draft_text;
      if(path==="lab")await (appendAssistantMessage as any)._handler(f.ctx,{thread_id:f.thread,account_slug:"leo",text,run_id:"run"});
      else await (recordSentReply as any)._handler(f.ctx,{thread_id:f.thread,account_slug:"leo",text,message_id:"owner-sent"});
      expect(f.tables.hygglo_messages.at(-1)).toMatchObject({sender:"owner",body_text:text,quoted_additions:[expect.objectContaining({items:[{product_id:1116294,qty:1},{product_id:1172765,qty:1}],total_gbp:194,additional_cost_gbp:70,physical_identity_key:"native-addition-key",quoted_for_message_id:"renter-current",epoch:5})]});
    });
  }
  for(const variant of ["edited_text","wrong_inbound","old_epoch","old_context","review_rejected","owner_latest","no_evidence","already_applied","no_order"]){
    it(`does not attach evidence from ${variant}`,async()=>{
      const f=fixture();let text=f.conversation.ai_draft_text;
      if(variant==="edited_text")text="The adapter costs £10 extra.";
      if(variant==="wrong_inbound")f.conversation.ai_draft_for_message_id="older";
      if(variant==="old_epoch")f.conversation.ai_draft_epoch=4;
      if(variant==="old_context")f.conversation.ai_draft_context_key="old-basket";
      if(variant==="review_rejected")f.conversation.ai_draft_review={for_message_id:"renter-current",context_key:f.conversation.ai_draft_context_key,epoch:5,reason:"needs_human",flags:[]};
      if(variant==="owner_latest")f.tables.hygglo_messages[0].sender="owner";
      if(variant==="already_applied") {f.tables.renter_bot_lab_orders[0].items.push({name:"Remus 100mm",qty:1});f.conversation.ai_draft_context_key=draftContextKey(null,undefined,f.tables.renter_bot_lab_orders[0]);}
      if(variant==="no_order")f.tables.renter_bot_lab_orders=[];
      if(variant==="no_evidence")delete f.conversation.ai_draft_evidence;
      expect(await sentAdditionProposals(f.ctx,f.conversation,text)).toEqual([]);
    });
  }
});

describe("sent date offer archive",()=>{
 for(const path of ["lab","owner"]){
  it(`${path} archives the exact full quote for later acceptance`,async()=>{
   const f=fixture();const order=f.tables.renter_bot_lab_orders[0];
   f.conversation.ai_draft_text="I can extend your booking to 20–22 October for £170 total.";
   f.conversation.ai_draft_evidence.prices=[{names:[],kind:"basket",source:"native_lab_date_proposal",call_id:"native-date",items:order.items.map((i:any)=>({name:i.name,quantity:i.qty})),total_gbp:170,start_date:"2026-10-20",end_date:"2026-10-22",date_proposal:{physical_identity_key:"native-date-key",before_context_key:f.conversation.ai_draft_context_key,from_start_date:order.start_date,from_end_date:order.end_date,base_total_gbp:124}}];
   const text=f.conversation.ai_draft_text;
   if(path==="lab")await (appendAssistantMessage as any)._handler(f.ctx,{thread_id:f.thread,account_slug:"leo",text,run_id:"date"});
   else await (recordSentReply as any)._handler(f.ctx,{thread_id:f.thread,account_slug:"leo",text,message_id:"date-owner"});
   expect(f.tables.hygglo_messages.at(-1)).toMatchObject({quoted_dates:[expect.objectContaining({context_key:f.conversation.ai_draft_context_key,from_end_date:"2026-10-21",end_date:"2026-10-22",total_gbp:170,base_total_gbp:124,physical_identity_key:"native-date-key",quoted_for_message_id:"renter-current"})]});
  });
 }
});


describe("ordinary Native inquiry offer history",()=>{
 function quoted(){const f=fixture();f.conversation.ai_draft_text="For 3 days: 1 × Sony 16-35mm: £50. Total: £50.";
  f.conversation.ai_draft_evidence={model_id:"native-test",stage:"CONFIRMED_UPCOMING",prices:[],stock:[],stock_quotes:[{quote_key:"separate-native",new_inquiry:true,start_date:"2026-10-22",end_date:"2026-10-24",items:[{item_id:"sony16",name:"Sony 16-35mm",quantity:1}],listing_quote:{total_gbp:50,lines:[{product_id:123,name:"Sony 16-35mm",quantity:1,total_gbp:50}]}}]};return f;}
 for(const path of ["lab","owner"])it(`${path} retains the reviewed independent offer with its original request and context`,async()=>{
  const f=quoted(),text=f.conversation.ai_draft_text;
  if(path==="lab")await (appendAssistantMessage as any)._handler(f.ctx,{thread_id:f.thread,account_slug:"leo",text,run_id:"quote-history"});
  else await (recordSentReply as any)._handler(f.ctx,{thread_id:f.thread,account_slug:"leo",text,message_id:"owner-sent"});
  expect(f.tables.hygglo_messages.at(-1).quoted_inquiries).toEqual([{context_key:f.conversation.ai_draft_context_key,epoch:5,quoted_for_message_id:"renter-current",quote:f.conversation.ai_draft_evidence.stock_quotes[0]}]);
 });
 for(const path of ["lab","owner"])it(`${path} retains each selected Native alternative rather than losing the whole offer`,async()=>{
  const f=quoted(),first=f.conversation.ai_draft_evidence.stock_quotes[0];
  const second={...structuredClone(first),quote_key:"longer-native",end_date:"2026-10-28",listing_quote:{total_gbp:90,lines:[{...first.listing_quote.lines[0],total_gbp:90}]}};
  f.conversation.ai_draft_evidence.stock_quotes.push(second);
  f.conversation.ai_draft_text+=" Alternatively, 7 days to 28 October: £90 total.";const text=f.conversation.ai_draft_text;
  if(path==="lab")await (appendAssistantMessage as any)._handler(f.ctx,{thread_id:f.thread,account_slug:"leo",text,run_id:"quote-options"});
  else await (recordSentReply as any)._handler(f.ctx,{thread_id:f.thread,account_slug:"leo",text,message_id:"options-owner"});
  expect(f.tables.hygglo_messages.at(-1).quoted_inquiries).toEqual([first,second].map(quote=>({context_key:f.conversation.ai_draft_context_key,epoch:5,quoted_for_message_id:"renter-current",quote})));
 });
 it("cannot archive edited, stale, unscoped, ambiguous or inconsistent offers",async()=>{
  for(const variant of ["edit","stale","unscoped","ambiguous","total"]){
   const f=quoted();let text=f.conversation.ai_draft_text;
   if(variant==="edit")text=text.replaceAll("£50","£40");
   if(variant==="stale")f.conversation.ai_draft_epoch=4;
   if(variant==="unscoped")delete f.conversation.ai_draft_evidence.stock_quotes[0].new_inquiry;
   if(variant==="ambiguous")f.conversation.ai_draft_evidence.stock_quotes.push(f.conversation.ai_draft_evidence.stock_quotes[0]);
   if(variant==="total")f.conversation.ai_draft_evidence.stock_quotes[0].listing_quote.total_gbp=60;
   expect((await sentBookingProposals(f.ctx,f.conversation,text)).inquiries).toEqual([]);
  }
 });
});


describe("served rental request lineage",()=>{
 for(const path of ["lab","owner"])it(`${path} persists quote-free replies and their real inbound root`,async()=>{
  const f=fixture(),request={kind:"inquiry",origin_message_id:"renter-current"};
  f.conversation.ai_draft_text="I can check suitable options for that shoot.";
  f.conversation.ai_draft_evidence={model_id:"test",stage:"CONFIRMED_UPCOMING",stock:[],rental_request:request};
  const text=f.conversation.ai_draft_text;
  if(path==="lab")await (appendAssistantMessage as any)._handler(f.ctx,{thread_id:f.thread,account_slug:"leo",text,run_id:"request"});
  else await (recordSentReply as any)._handler(f.ctx,{thread_id:f.thread,account_slug:"leo",text,message_id:"request-owner"});
  expect(f.conversation.active_rental_request).toEqual(request);
  expect(f.tables.hygglo_messages[0].rental_request).toEqual(request);
  expect(f.tables.hygglo_messages.at(-1).rental_request).toEqual(request);
  expect(f.tables.hygglo_messages.at(-1).quoted_inquiries).toBeUndefined();
 });
 it("does not move request lineage for a changed reply or stale approval",async()=>{
  for(const stale of [true,false]){
   const f=fixture();f.conversation.ai_draft_evidence.rental_request={kind:"inquiry",origin_message_id:"renter-current"};
   if(stale)f.conversation.ai_draft_epoch=4;
   await (appendAssistantMessage as any)._handler(f.ctx,{thread_id:f.thread,account_slug:"leo",text:stale?f.conversation.ai_draft_text:"A different reply",run_id:"unapproved-request"});
   expect(f.conversation.active_rental_request).toBeUndefined();
   expect(f.tables.hygglo_messages[0].rental_request).toBeUndefined();
  }
 });
 it("rejects a fabricated or foreign request origin atomically",async()=>{
  const f=fixture();f.conversation.ai_draft_evidence.rental_request={kind:"inquiry",origin_message_id:"foreign-renter"};
  await expect((appendAssistantMessage as any)._handler(f.ctx,{thread_id:f.thread,account_slug:"leo",text:f.conversation.ai_draft_text,run_id:"bad-root"})).rejects.toThrow("origin");
  expect(f.conversation.active_rental_request).toBeUndefined();expect(f.tables.hygglo_messages).toHaveLength(1);
 });
});

it("does not archive an exact quote under a different rental request",()=>{
 const f=fixture();const a={kind:"inquiry",origin_message_id:"a"},b={kind:"inquiry",origin_message_id:"b"};
 const quote={quote_key:"native",rental_request:a,new_inquiry:true,start_date:"2026-10-20",end_date:"2026-10-21",items:[{item_id:"lens",name:"Lens",quantity:1}],listing_quote:{total_gbp:50,lines:[{product_id:1,name:"Lens",quantity:1,total_gbp:50}]}};
 expect(sentInquiryOffers({...f.conversation.ai_draft_evidence,rental_request:b,stock_quotes:[quote]},scope)).toEqual([]);
});


describe("human edits around Native financial blocks",()=>{
 const block="For 3 days (22 October 2026 to 24 October 2026):\n- 1 × Sony 16-35mm: £50\nTotal: £50";
 for(const path of ["lab","owner"])it(`${path} preserves the quote and hire identity after surrounding prose changes`,async()=>{
  const f=fixture(),request={kind:"inquiry",origin_message_id:"renter-current"};
  const quote={quote_key:"native",rental_request:request,new_inquiry:true,offer_text:block,start_date:"2026-10-22",end_date:"2026-10-24",items:[{item_id:"sony16",name:"Sony 16-35mm",quantity:1}],listing_quote:{total_gbp:50,lines:[{product_id:123,name:"Sony 16-35mm",quantity:1,total_gbp:50}]}};
  f.conversation.ai_draft_text="Here is the quote:\n\n"+block+"\n\nDoes it work for you?";
  f.conversation.ai_draft_evidence={model_id:"native-test",stage:"CONFIRMED_UPCOMING",stock:[],prices:[],rental_request:request,stock_quotes:[quote]};
  const text="Thanks for waiting.\n\n"+block+"\n\nWould you like to go ahead?";
  if(path==="lab")await (appendAssistantMessage as any)._handler(f.ctx,{thread_id:f.thread,account_slug:"leo",text,run_id:"edited-native"});
  else await (recordSentReply as any)._handler(f.ctx,{thread_id:f.thread,account_slug:"leo",text,message_id:"edited-native"});
  expect(f.tables.hygglo_messages.at(-1).quoted_inquiries).toEqual([{context_key:f.conversation.ai_draft_context_key,epoch:5,quoted_for_message_id:"renter-current",quote}]);
  expect(f.tables.hygglo_messages.at(-1).rental_request).toEqual(request);expect(f.conversation.active_rental_request).toEqual(request);
 });
});
