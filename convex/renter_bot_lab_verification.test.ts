import { REFERRAL_RESTORE_OFFER } from "./lib/referral_offer";
import { draftContextKey } from "./lib/draft_review";
import { describe, expect, it } from "vitest";
import { simulateVerificationFailure, redeemReferral, applyChange, get } from "./renter_bot_lab_order";
import { parseReferralRestoreTurnKey } from "./lib/renter_bot_lab_turn_action";
import { __service_claimTestTurn, sendTestMessage } from "./renter_bot_lab_actions";
function fixture() {
  const tables: Record<string, any[]> = {
    items: [{ _id: "camera", name_canonical: "Sony FX3", status: "active", is_marketing_only: false, qty: 1, kind: "camera_body", aliases: [] }],
    renter_bot_lab_orders: [{ _id: "order", thread_id: "__probe__atomic", account_slug: "leo", start_date: "2026-10-06", end_date: "2026-10-07", changes: [],
      items: [{ item_id: "camera", name: "Sony FX3", qty: 1, daily_price_gbp: 40, pricing_basis: "listing", origin: "seed" }] }],
    renter_bot_lab_bookings: [{ _id: "booking", hygglo_order_id: "__probe__atomic", start_date: "2026-10-06", end_date: "2026-10-07", pickup_date: "2026-10-06" }],
  };
  const db = {
    normalizeId: (table:string,id:string) => Object.entries(tables).find(([,rows])=>rows.some(row=>row._id===id))?.[0]===table?id:null,
    query: (table: string) => {
      const filters: Array<[string, any]> = [];
      let direction="asc";
      const q = { eq: (key: string, value: any) => { filters.push([key, value]); return q; } };
      const result: any = { withIndex: (_name: string, select: any) => { select(q); return result; },
        order: (value:string) => { direction=value; return result; },
        [Symbol.asyncIterator]: async function* () {
          const rows=await result.collect();
          rows.sort((a:any,b:any)=>(a.hygglo_sent_at??0)-(b.hygglo_sent_at??0));
          if(direction==="desc")rows.reverse();
          yield* rows;
        },
        collect: async () => (tables[table] ?? []).filter(row => filters.every(([key, value]) => row[key] === value)),
        first: async () => (await result.collect())[0] ?? null, unique: async () => (await result.collect())[0] ?? null };
      return result;
    },
    get: async (id: string) => Object.values(tables).flat().find(r => r._id === id) ?? null,
    insert: async (table: string, value: any) => { const id = `${table}-${(tables[table] ?? []).length}`; (tables[table] ??= []).push({...value,_id:id}); return id; },
    patch: async (id: string, value: any) => { const row = Object.values(tables).flat().find(r => r._id === id); Object.assign(row, value); },
  };
  return { tables, ctx: { db } };
}

const code="a762acfe-9493-4c7f-ae52-fcb8ac61e2ae";
const fail=(ctx:any, thread_id="__probe__atomic")=>(simulateVerificationFailure as any)._handler(ctx,{thread_id,referral_code:code});
const redeem=(ctx:any, referral=code)=>(redeemReferral as any)._handler(ctx,{thread_id:"__probe__friend",code:referral});
function setup() {
 const f=fixture();
 Object.assign(f.tables.renter_bot_lab_bookings[0],{pickup_date:undefined,status:"pending_review",order_step:"VERIFIED",start_date:"2099-10-06",end_date:"2099-10-07"});
 Object.assign(f.tables.renter_bot_lab_orders[0],{start_date:"2099-10-06",end_date:"2099-10-07"});
 f.tables.renter_bot_lab_orders.push({_id:"friend",thread_id:"__probe__friend",account_slug:"leo",items:[],changes:[]});
 f.tables.hygglo_messages=[{thread_id:"__probe__friend",message_id:"friend-inbound",sender:"renter",body_text:`My friend sent me referral ${code}. Please restore the same basket.`,hygglo_sent_at:1}];
 f.tables.conversations=[{_id:"friend-conv",thread_id:"__probe__friend",inquiry_items:[]}];
 f.tables.online_listings=[{account_slug:"leo",product_id:1,name:"Sony FX3",daily_price:55}];
 f.tables.hygglo_products=[{accountSlug:"leo",productId:1,name:"Sony FX3",masterItemId:"camera",prices:[]}];
 f.tables.hygglo_product_index=[{account_slug:"leo",product_id:1,item_id:"camera"}];
 f.tables.listing_resolution_override=[{account_slug:"leo",product_id:1,components:[{item_id:"camera",qty:1}]}];
 return f;
}
describe("authoritative Lab verification failure and friend handoff",()=>{
 it("does not reprice a prepared listing as a generic item when restoring a friend's basket",async()=>{
  const f=setup();
  Object.assign(f.tables.renter_bot_lab_orders[0].items[0], {source_product_id:1097510,daily_price_gbp:49,pricing_basis:"listing"});
  await fail(f.ctx);
  const before=structuredClone(f.tables);
  expect(await redeem(f.ctx)).toMatchObject({ok:false,reason:"referral_listing_mapping_unverified"});
  expect(f.tables).toEqual(before);
 });
 it("accepts yes only against the exact sent Native referral offer with fresh prices and dates",async()=>{
  for(const variant of ["valid","no_offer","wrong_referral","wrong_price","old_context","read_only","missing_technical_proof","valid_technical_proof"]){
   const f=setup();f.tables.settings=[{_id:"settings",draft_epoch:1}];f.tables.renter_bot_lab_orders[0].items[0].product_id=1;await fail(f.ctx);
   const target=f.tables.renter_bot_lab_orders[1];
   const proposal={context_key:draftContextKey(null,[],target),epoch:1,quoted_for_message_id:"friend-inbound",referral_code:code,
    physical_identity_key:JSON.stringify([["camera","Sony FX3",1]]),items:[{product_id:1,qty:1}],base_items:[],added_items:[{name:"Sony FX3",quantity:1}],
    start_date:"2099-10-08",end_date:"2099-10-09",total_gbp:110,additional_cost_gbp:110};
   if(["missing_technical_proof","valid_technical_proof"].includes(variant))(proposal as any).recommendation_requirements=[{kind:"camera",quantity:1,requirements:{internal_4k:true}}];
   if(variant==="valid_technical_proof")f.tables.item_specs=[{item_id:"camera",item_name_canonical:"Sony FX3",description:"Reviewed body",source:"owner-verified",verified_model:"Sony FX3",verified_at:1,
    camera_capabilities:{role:"interchangeable_lens",sensor_format:"full_frame",native_mount:"E",internal_4k:true,verified_model:"Sony FX3",verified_at:1}}];
   if(variant==="wrong_referral")proposal.referral_code="other";if(variant==="wrong_price")proposal.total_gbp=120;if(variant==="old_context")proposal.context_key="old";
   f.tables.hygglo_messages.push({thread_id:"__probe__friend",message_id:"owner-offer",sender:"owner",body_text:"For 2 days (8 October 2099 to 9 October 2099):\n- 1 × Sony FX3: £110\nTotal: £110\n\n"+REFERRAL_RESTORE_OFFER,
     quoted_additions:variant==="no_offer"?[]:[proposal],hygglo_sent_at:2},
    {thread_id:"__probe__friend",message_id:"accepted",sender:"renter",body_text:variant==="read_only"?"Yes please, quote only, do not add anything.":"yes please",hygglo_sent_at:3});
   const before=structuredClone(f.tables);
   const result=await (redeemReferral as any)._handler(f.ctx,{thread_id:"__probe__friend",code,request_message_id:"accepted",start_date:"2099-10-08",end_date:"2099-10-09",items:[{product_id:1,qty:1}]});
   if(variant==="valid"||variant==="valid_technical_proof"){expect(result).toMatchObject({ok:true,action_performed:true,order:{start_date:"2099-10-08",end_date:"2099-10-09",total_gbp:110}});expect(f.tables.renter_bot_lab_bookings).toHaveLength(1);}
   else {expect(result,variant).toMatchObject({ok:false});expect(f.tables,variant).toEqual(before);}
  }
 });

 it("automatically cancels only the simulated booking and sends one policy message on replay",async()=>{
  const f=setup(); expect(await fail(f.ctx)).toMatchObject({ok:true,already_applied:false});
  expect(f.tables.renter_bot_lab_bookings[0]).toMatchObject({status:"cancelled",order_step:"VERIFICATION_FAILED"});
  expect(await fail(f.ctx)).toMatchObject({already_applied:true});
  expect(f.tables.hygglo_messages.filter(m=>m.thread_id==="__probe__atomic")).toHaveLength(1);expect(f.tables.renter_bot_lab_referrals).toHaveLength(1);
  expect(f.tables.hygglo_messages.find(m=>m.thread_id==="__probe__atomic").body_text).toContain("approval isn't guaranteed");
  expect(f.tables.hygglo_messages.find(m=>m.thread_id==="__probe__atomic").body_text).toMatch(/verified friend/i);
  expect(f.tables.hygglo_messages.find(m=>m.thread_id==="__probe__atomic").body_text).not.toMatch(/Hygglo|Fat Llama/i);
  expect(f.tables.renter_bot_lab_orders[0].items).toHaveLength(1);
 });
 it("rejects real threads and stages other than awaiting verification without changes",async()=>{
  const f=setup();let before=structuredClone(f.tables);await expect(fail(f.ctx,"actual-hygglo")).rejects.toThrow();expect(f.tables).toEqual(before);
  f.tables.renter_bot_lab_bookings[0].order_step="APPROVED";before=structuredClone(f.tables);
  await expect(fail(f.ctx)).rejects.toThrow("awaiting verification");expect(f.tables).toEqual(before);
 });
 it("keeps the cancelled source closed to additions",async()=>{
  const f=setup();await fail(f.ctx);
  expect(await (applyChange as any)._handler(f.ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony FX3",qty:1})).toMatchObject({ok:false});
 });
 it("restores identities and quantity at today's price without inheriting a booking; replay does not duplicate",async()=>{
  const f=setup();await fail(f.ctx);const restored=await redeem(f.ctx);expect(restored).toMatchObject({ok:true,already_applied:false,order:{total_gbp:110}});
  expect(restored.message).toContain("£110");expect(restored.message).toContain("not a confirmed booking");
  expect(f.tables.renter_bot_lab_orders[1].items[0]).toMatchObject({item_id:"camera",qty:1,daily_price_gbp:55});
  expect(f.tables.renter_bot_lab_bookings).toHaveLength(1);
  expect(await redeem(f.ctx)).toMatchObject({ok:true,already_applied:true});expect(f.tables.renter_bot_lab_orders[1].items).toHaveLength(1);
 });
 it("preserves a friend's own dates and reprices the whole restored duration",async()=>{
  const f=setup();await fail(f.ctx);
  Object.assign(f.tables.renter_bot_lab_orders[1],{start_date:"2099-10-08",end_date:"2099-10-10"});
  const result=await redeem(f.ctx);expect(result).toMatchObject({ok:true,order:{start_date:"2099-10-08",end_date:"2099-10-10",total_gbp:165}});
  expect(result.stock_receipts.every((r:any)=>r.start_date==="2099-10-08"&&r.end_date==="2099-10-10")).toBe(true);
  expect(f.tables.renter_bot_lab_orders[0]).toMatchObject({start_date:"2099-10-06",end_date:"2099-10-07"});
 });
 it("checks stock for the friend's dates rather than the available original dates",async()=>{
  const f=setup();await fail(f.ctx);
  Object.assign(f.tables.renter_bot_lab_orders[1],{start_date:"2099-10-08",end_date:"2099-10-10"});
  f.tables.vacation_periods=[{is_active:true,start_date:"2099-10-08",end_date:"2099-10-10"}];
  const before=structuredClone(f.tables);const result=await redeem(f.ctx);expect(result).toMatchObject({ok:false});
  expect(result.stock_receipts).toEqual(expect.arrayContaining([expect.objectContaining({available:false,start_date:"2099-10-08",end_date:"2099-10-10"})]));expect(f.tables).toEqual(before);
 });
 it("can restore gear for the friend's future trip after the original dates have passed",async()=>{
  const f=setup();await fail(f.ctx);
  Object.assign(f.tables.renter_bot_lab_orders[0],{start_date:"2020-10-06",end_date:"2020-10-07"});
  Object.assign(f.tables.renter_bot_lab_orders[1],{start_date:"2099-10-08",end_date:"2099-10-10"});
  expect(await redeem(f.ctx)).toMatchObject({ok:true,order:{total_gbp:165}});
 });
 it("holds incomplete, invalid, reversed or past friend dates without consumption or changes",async()=>{
  for(const dates of [{start_date:"2099-10-08"},{end_date:"2099-10-10"},{start_date:"2099-02-30",end_date:"2099-03-01"},{start_date:"2099-10-10",end_date:"2099-10-08"},{start_date:"2020-10-08",end_date:"2020-10-10"}]){
   const f=setup();await fail(f.ctx);Object.assign(f.tables.renter_bot_lab_orders[1],dates);const before=structuredClone(f.tables);
   expect(await redeem(f.ctx)).toMatchObject({ok:false});expect(f.tables).toEqual(before);
  }
 });
 it("previews without changing either request, consuming the code or claiming restoration",async()=>{
  const f=setup();await fail(f.ctx);const inbound=f.tables.hygglo_messages.find(m=>m.thread_id==="__probe__friend");
  inbound.body_text=`My friend sent me referral ${code}, but do not add their gear or change my basket. Quote only.`;
  const before=structuredClone(f.tables);
  const preview=await (redeemReferral as any)._handler(f.ctx,{thread_id:"__probe__friend",code,preview_only:true});
  expect(preview).toMatchObject({ok:true,preview_only:true,action_performed:false,order:{total_gbp:110}});expect(preview.message).toContain("basket preview");expect(preview.message).not.toContain("I've restored");expect(f.tables).toEqual(before);
  expect(await redeem(f.ctx)).toMatchObject({ok:false,reason:"referral_restore_not_authorized"});expect(f.tables).toEqual(before);
  inbound.body_text=`My friend sent me referral ${code}. Please restore the same basket.`;
  expect(await redeem(f.ctx)).toMatchObject({ok:true,already_applied:false});
 });
 it("uses planned friend dates and quantities while keeping the source and current inbound intact",async()=>{
  const f=setup();f.tables.items[0].qty=2;f.tables.renter_bot_lab_orders[0].items[0].product_id=1;await fail(f.ctx);
  const sourceBefore=structuredClone(f.tables.renter_bot_lab_orders[0]),messagesBefore=f.tables.hygglo_messages.length;
  f.tables.hygglo_messages.find(m=>m.thread_id==="__probe__friend").body_text=`Referral ${code}. Please restore the same gear but two cameras for 8–10 October 2099.`;
  const result=await (redeemReferral as any)._handler(f.ctx,{thread_id:"__probe__friend",code,request_message_id:"friend-inbound",start_date:"2099-10-08",end_date:"2099-10-10",items:[{product_id:1,qty:2}]});
  expect(result).toMatchObject({ok:true,action_performed:true,order:{start_date:"2099-10-08",end_date:"2099-10-10",total_gbp:330},context_transition:{source:"native_lab_amendment",thread_id:"__probe__friend",before_revision:0,after_revision:1}});
  expect(result.context_transition.before_context_key).not.toBe(result.context_transition.after_context_key);
  expect(parseReferralRestoreTurnKey(f.tables.renter_bot_lab_orders[1].changes.at(-1)?.request_key,"friend-inbound")).toEqual({
   request_message_id:"friend-inbound",referral_code:code,start_date:"2099-10-08",end_date:"2099-10-10",items:[{product_id:1,qty:2}],
  });
  expect(result.verified_inquiry_quote).toMatchObject({thread_id:"__probe__friend",account_slug:"leo",rental_stage:"INQUIRY",basket:{available:true},quote:{source:"native_inquiry_basket",total_gbp:330,start_date:"2099-10-08",end_date:"2099-10-10"}});
  expect(f.tables.renter_bot_lab_orders[0]).toEqual(sourceBefore);expect(f.tables.renter_bot_lab_orders[1].items[0].qty).toBe(2);
  expect(f.tables.hygglo_messages).toHaveLength(messagesBefore);expect(f.tables.renter_bot_lab_bookings).toHaveLength(1);
 });
 it("recovers a same-message restore receipt from the current order read and drops it if that order changes",async()=>{
  const f=setup();f.tables.renter_bot_lab_orders[0].items[0].product_id=1;await fail(f.ctx);
  const restored=await (redeemReferral as any)._handler(f.ctx,{thread_id:"__probe__friend",code,request_message_id:"friend-inbound",
   start_date:"2099-10-08",end_date:"2099-10-09",items:[{product_id:1,qty:1}]});
  expect(restored).toMatchObject({ok:true,action_performed:true});
  const read=()=> (get as any)._handler(f.ctx,{thread_id:"__probe__friend",request_message_id:"friend-inbound"});
  const view=await read();
  expect(view.same_turn_replay).toMatchObject({source:"native_lab_amendment",action:"restore_referral_basket",thread_id:"__probe__friend",
   account_slug:"leo",request_message_id:"friend-inbound",start_date:"2099-10-08",end_date:"2099-10-09",items:[{product_id:1,qty:1}]});
  f.tables.renter_bot_lab_orders[1].items[0].qty=2;
  expect((await read()).same_turn_replay).toBeUndefined();
  expect((await (get as any)._handler(f.ctx,{thread_id:"__probe__friend",request_message_id:"another-message"})).same_turn_replay).toBeUndefined();
 });
 it("recognition, information and hypothetical instructions never authorise restoration",async()=>{
  for(const text of [`My friend sent me referral ${code}.`,`Referral ${code}. What equipment is included?`,`Referral ${code}. If I ask you to restore the basket, what happens?`,`Referral ${code}. Please do not restore the basket.`]){
   const f=setup();await fail(f.ctx);f.tables.hygglo_messages.find(m=>m.thread_id==="__probe__friend").body_text=text;const before=structuredClone(f.tables);
   expect(await redeem(f.ctx)).toMatchObject({ok:false,reason:"referral_restore_not_authorized"});expect(f.tables).toEqual(before);
  }
 });
 it("rejects stale scoped messages, foreign gear and malformed selections atomically",async()=>{
  for(const extra of [{request_message_id:"old"},{items:[{product_id:999,qty:1}]},{items:[{product_id:1,qty:0}]},{items:[{product_id:1,qty:1},{product_id:1,qty:1}]},{items:[]},{start_date:"2099-10-08"}]){
   const f=setup();f.tables.renter_bot_lab_orders[0].items[0].product_id=1;await fail(f.ctx);const before=structuredClone(f.tables);
   expect(await (redeemReferral as any)._handler(f.ctx,{thread_id:"__probe__friend",code,request_message_id:"friend-inbound",...extra})).toMatchObject({ok:false});expect(f.tables).toEqual(before);
  }
 });
 it("never lets a tool supply a valid referral that the renter did not share",async()=>{
  const f=setup();await fail(f.ctx);f.tables.hygglo_messages.find(m=>m.thread_id==="__probe__friend").body_text="Please restore the same basket.";const before=structuredClone(f.tables);
  expect(await redeem(f.ctx)).toMatchObject({ok:false,reason:"referral_not_in_current_context"});expect(f.tables).toEqual(before);
 });
 it("holds native restoration without a current renter instruction, including after an owner preview",async()=>{
  for(const sender of ["owner",null]){const f=setup();await fail(f.ctx);
   const inbound=f.tables.hygglo_messages.find(m=>m.thread_id==="__probe__friend");if(sender)inbound.sender=sender;else f.tables.hygglo_messages=f.tables.hygglo_messages.filter(m=>m!==inbound);
   const before=structuredClone(f.tables);expect(await redeem(f.ctx)).toMatchObject({ok:false,reason:"referral_restore_not_authorized"});expect(f.tables).toEqual(before);
  }
 });
 it("does not link a stranger or a used, expired or wrong-account referral",async()=>{
  const f=setup();await fail(f.ctx);const before=structuredClone(f.tables);expect(await redeem(f.ctx,"Sam sent me")).toMatchObject({ok:false});expect(f.tables).toEqual(before);
  f.tables.renter_bot_lab_orders[1].account_slug="daniel";expect(await redeem(f.ctx)).toMatchObject({ok:false});
  f.tables.renter_bot_lab_orders[1].account_slug="leo";f.tables.renter_bot_lab_referrals[0].expires_at=0;expect(await redeem(f.ctx)).toMatchObject({ok:false});
 });
 it("does not partially rebuild or consume a code if stock or current prices are missing",async()=>{
  for(const change of ["stock","price"]){const f=setup();await fail(f.ctx);if(change==="stock")f.tables.items[0].qty=0;else f.tables.online_listings=[];
   const before=structuredClone(f.tables);expect(await redeem(f.ctx)).toMatchObject({ok:false});expect(f.tables).toEqual(before);
  }
 });
 it("does not silently substitute another available camera when a listing mapping changes",async()=>{
  const f=setup();f.tables.renter_bot_lab_orders[0].items[0].product_id=1;
  await fail(f.ctx);
  expect(f.tables.renter_bot_lab_referrals[0].physical_items).toEqual([{item_id:"camera",name:"Sony FX3",quantity:1}]);
  f.tables.items.push({...f.tables.items[0],_id:"other-camera",name_canonical:"Sony FX6"});
  f.tables.listing_resolution_override[0].components=[{item_id:"other-camera",qty:1}];
  f.tables.online_listings[0].name="Sony FX6";
  const {checkOrderRentalStock}=await import("./lib/renter_order_stock");
  expect(await checkOrderRentalStock(f.ctx as any,"leo",f.tables.renter_bot_lab_orders[0].items,"2099-10-06","2099-10-07","__probe__friend")).toMatchObject({available:true});
  const before=structuredClone(f.tables);
  expect(await redeem(f.ctx)).toMatchObject({ok:false,reason:"referral_basket_identity_changed_or_unverified"});
  expect(f.tables).toEqual(before);
 });
 it("requires review for changed quantities, relabelled inventory identities and legacy referrals",async()=>{
  for(const change of ["quantity","identity_name","legacy"]) {
   const f=setup();f.tables.renter_bot_lab_orders[0].items[0].product_id=1;f.tables.items[0].qty=4;
   await fail(f.ctx);
   if(change==="quantity")f.tables.listing_resolution_override[0].components[0].qty=2;
   else if(change==="identity_name")f.tables.items[0].name_canonical="Sony FX6";
   else delete f.tables.renter_bot_lab_referrals[0].physical_items;
   const before=structuredClone(f.tables);
   expect(await redeem(f.ctx)).toMatchObject({ok:false,reason:"referral_basket_identity_changed_or_unverified"});
   expect(f.tables).toEqual(before);
  }
 });
 it("still cancels a final verification failure when the source catalogue is unresolved",async()=>{
  const f=setup();f.tables.renter_bot_lab_orders[0].items[0].product_id=1;f.tables.listing_resolution_override=[];
  expect(await fail(f.ctx)).toMatchObject({ok:true});
  expect(f.tables.renter_bot_lab_bookings[0].status).toBe("cancelled");
  expect(f.tables.renter_bot_lab_referrals[0].physical_items).toBeUndefined();
  const before=structuredClone(f.tables);expect(await redeem(f.ctx)).toMatchObject({ok:false});expect(f.tables).toEqual(before);
 });
});

describe("lower-value recommendations use recorded replacement value",()=>{
 const run=async(f:any,name="Canon EF 24-105mm f/4")=>{
  const {find_owned_alternatives}=await import("./renter_bot_tools");
  return (find_owned_alternatives as any)._handler(f.ctx,{account_slug:"leo",kind:"lens",lens_requirements:{},item_name:name,lower_value_only:true});
 };
 function lenses(){const f=fixture();f.tables.items=[
  {_id:"original",name_canonical:"Canon EF 24-105mm f/4",kind:"lens",lens_mount:"EF",qty:1,status:"active",is_marketing_only:false,replacement_cost_gbp:1000},
  {_id:"lower",name_canonical:"Canon EF 16-35mm f/2.8",kind:"lens",lens_mount:"EF",qty:1,status:"active",is_marketing_only:false,replacement_cost_gbp:800},
  {_id:"higher",name_canonical:"Canon EF 70-200mm f/2.8",kind:"lens",lens_mount:"EF",qty:1,status:"active",is_marketing_only:false,replacement_cost_gbp:1200},
  {_id:"unknown",name_canonical:"Canon EF 50mm f/1.8",kind:"lens",lens_mount:"EF",qty:1,status:"active",is_marketing_only:false},
 ];return f;}
 it("returns only known lower replacement values, independent of daily rental cost",async()=>{
  const result=await run(lenses());expect(result).toMatchObject({target_identity_resolved:true,target_replacement_cost_gbp:1000,verification_approval_guaranteed:false,count:1});
  expect(result.alternatives[0]).toMatchObject({name:"Canon EF 16-35mm f/2.8",replacement_cost_gbp:800});
 });
 it("fails closed for unknown original values and uncertain item variants",async()=>{
  const f=lenses();delete f.tables.items[0].replacement_cost_gbp;
  expect(await run(f)).toMatchObject({count:0});
  expect(await run(lenses(),"Canon RF 16-35mm f/2.8")).toMatchObject({target_identity_resolved:false,count:0});
 });
});


describe("friend recognition requires an explicit opaque referral",()=>{
 it("recognizes a direct request to add the quoted gear while rejecting conditions",async()=>{
  const {requestsFriendBasketRestore}=await import("./lib/verification_failure");
  expect(requestsFriendBasketRestore("Yes, that location works and please add the quoted gear to my request.")).toBe(true);
  expect(requestsFriendBasketRestore("Yes, please add the same BMPCC 6K Full Frame kit from that referral to my inquiry for 11 December.")).toBe(true);
  expect(requestsFriendBasketRestore("Could you check the same BMPCC 6K Full Frame for 11 December, tell me the current price, and add it to my own request if it is available?")).toBe(true);
  expect(requestsFriendBasketRestore("Can you check availability and price and add it to my new inquiry?")).toBe(true);
  expect(requestsFriendBasketRestore("Could you check the same kit, tell me the price, and add it to my new inquiry if it is available?")).toBe(true);
  expect(requestsFriendBasketRestore("If it is available, please add the same camera to my request.")).toBe(true);
  for(const text of ["If I ask you to add the quoted gear, what happens?","Please do not add the quoted gear.","Wait, add the quoted gear after I confirm.","How do I add this camera kit?","Maybe add it to my request if it is available.","Please add it to my request if I confirm the price and it is available."])
   expect(requestsFriendBasketRestore(text),text).toBe(false);
 });
 it("accepts a friend's referral in chat without identifying anyone by name",async()=>{
  const {friendReferralFromMessage}=await import("./lib/verification_failure");
  expect(friendReferralFromMessage(`Alex sent me; referral ${code}. Please restore the same basket.`)).toBe(code);
  expect(friendReferralFromMessage("Alex sent me. Same surname, add their gear.")).toBeNull();
  expect(friendReferralFromMessage(code)).toBeNull();
  expect(friendReferralFromMessage(`referral ${code} or 7ac021cf-611b-487d-b4b3-c974a32aa9dc`)).toBeNull();
 });
});

describe("Lab retry lease recovery",()=>{
 function claimHarness(status:string,run:Record<string,unknown>){
  const turn:Record<string,unknown>={_id:"turn-row",turn_id:"turn-12345678",thread_id:"__probe__friend",account_slug:"dbcinema",
   renter_message_id:"message-1",renter_text:"Please add the gimbal",status,run_id:"run-1",lease_started_at:1,updated_at:1};
  const savedRun={_id:"run-1",lab_turn_id:"turn-12345678",session_thread_id:"__probe__friend",account_slug:"dbcinema",...run};
  const tables:Record<string,Record<string,unknown>[]>={
   conversations:[{_id:"conversation-row",thread_id:"__probe__friend",account_slug:"dbcinema",referral_reference:{codes:[],message_id:"message-1"}}],
   hygglo_messages:[{_id:"message-row",thread_id:"__probe__friend",account_slug:"dbcinema",message_id:"message-1",sender:"renter",body_text:"Please add the gimbal",hygglo_sent_at:1}],
   renter_bot_lab_turns:[turn],renter_bot_harness_runs:[savedRun],
  };
  const db={
   query:(table:string)=>{
    const filters:Array<[string,unknown]>=[];
    const q={eq:(field:string,value:unknown)=>{filters.push([field,value]);return q;}};
    const result:any={withIndex:(_name:string,select:(query:typeof q)=>void)=>{select(q);return result;},order:()=>result,
     first:async()=>tables[table]?.find(row=>filters.every(([field,value])=>row[field]===value))??null,
     collect:async()=>tables[table]?.filter(row=>filters.every(([field,value])=>row[field]===value))??[]};
    return result;
   },
   patch:async(id:string,patch:Record<string,unknown>)=>{const row=Object.values(tables).flat().find(candidate=>candidate._id===id);if(!row)throw new Error("missing row");Object.assign(row,patch);},
  };
  return {ctx:{db},turn};
 }
 const input=(lease_token:string)=>({turn_id:"turn-12345678",thread_id:"__probe__friend",account_slug:"dbcinema",
  request_message_id:"message-1",renter_text:"Please add the gimbal",lease_token});
 const claim=(ctx:unknown,args:ReturnType<typeof input>)=>(__service_claimTestTurn as any)._handler(ctx,args);

 it("reopens false-complete and failed no-reply turns, allowing only their retries through a held review",async()=>{
  const f=claimHarness("complete",{generation_status:"complete",overall_status:"fail",draft_text:"",rubric_results:[{category:"generation_outcome",status:"fail"}]});
  expect(await claim(f.ctx,input("lease-retry-1"))).toEqual({status:"claimed",requestMessageId:"message-1",leaseToken:"lease-retry-1",retryReview:true});
  expect(f.turn).toMatchObject({status:"running",lease_token:"lease-retry-1"});
  expect(await claim(f.ctx,input("lease-retry-2"))).toEqual({status:"running",requestMessageId:"message-1"});
  expect(f.turn).toMatchObject({lease_token:"lease-retry-1"});

  const failed=claimHarness("failed",{generation_status:"failed",failure_reason:"needs_human:invalid_model_output",draft_text:""});
  expect(await claim(failed.ctx,input("lease-retry-3"))).toEqual({status:"claimed",requestMessageId:"message-1",leaseToken:"lease-retry-3",retryReview:true});
  expect(failed.turn).toMatchObject({status:"running",lease_token:"lease-retry-3"});
 });

 it("does not bypass a held review when the prior run was not a failed no-reply",async()=>{
  const f=claimHarness("failed",{generation_status:"complete",overall_status:"flag",draft_text:"",rubric_results:[{category:"owner_review_completion",status:"flag"}]});
  expect(await claim(f.ctx,input("lease-retry-1"))).toEqual({status:"claimed",requestMessageId:"message-1",leaseToken:"lease-retry-1"});
 });

 it("keeps successful turns and deliberate owner handoffs idempotent",async()=>{
  const success=claimHarness("complete",{generation_status:"complete",overall_status:"pass",draft_text:"Verified reply",rubric_results:[]});
  expect(await claim(success.ctx,input("lease-retry-1"))).toEqual({status:"complete",requestMessageId:"message-1",runId:"run-1"});
  const handoff=claimHarness("complete",{generation_status:"complete",overall_status:"flag",draft_text:"",rubric_results:[{category:"owner_review_completion",status:"flag"}]});
  expect(await claim(handoff.ctx,input("lease-retry-1"))).toEqual({status:"complete",requestMessageId:"message-1",runId:"run-1"});
 });
});

describe("Lab generation failure evidence", () => {
 it("persists the rejected native-quote candidate in the run without adding it to the renter transcript", async () => {
  const args = {
   threadId: "__probe__candidate-visibility",
   accountSlug: "dbcinema",
   text: "Could you add the gimbal and tell me the new total?",
   turnId: "turn-candidate-visibility",
   leaseToken: "lease-candidate-visibility",
   requestMessageId: "message-candidate-visibility",
   triggeredBy: "lab_ui_manual" as const,
  };
  const runArgs: Record<string, unknown>[] = [];
  let queryIndex = 0;
  let mutationIndex = 0;
  let assistantAppends = 0;
  const ctx = {
   runQuery: async () => {
    queryIndex += 1;
    switch (queryIndex) {
     case 1: return { account_slug: args.accountSlug };
     case 2: return { thread_id: args.threadId, account_slug: args.accountSlug, status: "running", lease_token: args.leaseToken,
      renter_message_id: args.requestMessageId, renter_text: args.text };
     case 3: return { thread_id: args.threadId, account_slug: args.accountSlug, message_id: args.requestMessageId,
      sender: "renter", body_text: args.text };
     case 4: return null;
     case 5: return { messages: [], rental_stage: { stage: "INQUIRY" } };
     case 6: return [];
     default: throw new Error(`Unexpected Lab query ${queryIndex}`);
    }
   },
   runMutation: async (_reference: unknown, value: Record<string, unknown>) => {
    mutationIndex += 1;
    if (mutationIndex === 1) return { ok: false, reason: "no_accepted_offer" };
    if (mutationIndex === 2) { runArgs.push(value); return "run-candidate-visibility"; }
    assistantAppends += 1;
    return null;
   },
   runAction: async () => ({
    status: "skipped",
    reason: "canonical_generation_error_error",
    diagnostic_candidate: "The gimbal is available and changes the total to £80.",
    native_quote_diagnostic: "No account-scoped native quote receipt was available.",
    model_id: "google/gemini-3.7-flash",
    generation_error: { http_status: 502, error_code: "invalid_model_output", transient: false,
     lab_trace: { token_usage: { prompt: 1200, completion: 80, cached: 900, cost: 0.002 },
      tool_stats: { steps: 2, total: 1, byName: { lookup_pricing: 1 }, duplicates: 0, errors: 0,
       calls: [{ call_id: "call-1", name: "lookup_pricing", args: { item_name: "DJI RS3 Pro" }, result: { found: false }, error: false }] } } },
    token_usage: { prompt: 1200, completion: 80, cached: 900, cost: 0.002 },
    tool_stats: { steps: 2, total: 2, byName: { lookup_pricing: 1, check_basket_availability: 1 }, duplicates: 0, errors: 0 },
    evidence: { listing_sources: [], pickup_facts: [], prices: [], stock: [] },
   }),
  };

  const result = await (sendTestMessage as any)._handler(ctx, args);

  expect(result).toMatchObject({ status: "skipped", draft: "", assistantContextAdded: false });
  expect(runArgs).toHaveLength(1);
  expect(runArgs[0]).toMatchObject({ generation_status: "failed", candidate_text: "The gimbal is available and changes the total to £80.",
   draft_text: "", native_quote_diagnostic: "No account-scoped native quote receipt was available.",
   token_usage: { prompt: 1200, completion: 80, cached: 900, cost: 0.002 },
   generation_error: { lab_trace: { token_usage: { prompt: 1200 }, tool_stats: { byName: { lookup_pricing: 1 } } } } });
  expect(assistantAppends).toBe(0);
 });
});

describe("atomic Lab message binding and turn claim", () => {
 function harness(seedMessages: Record<string, any>[] = []) {
  const tables: Record<string, Record<string, any>[]> = {
   conversations: [{ _id: "conversation-1", thread_id: "__probe__atomic", account_slug: "diogo", referral_reference: { codes: [], message_id: "seed" } }],
   hygglo_messages: seedMessages.map(message => ({ ...message })),
   renter_bot_lab_turns: [], renter_bot_harness_runs: [],
  };
  const db = {
   query: (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let direction: "asc" | "desc" = "asc";
    const q = { eq: (field: string, value: unknown) => { filters.push([field, value]); return q; } };
    const matches = (row: Record<string, any>) => filters.every(([field, value]) => row[field] === value);
    const result: any = {
     withIndex: (_name: string, select: (query: typeof q) => void) => { select(q); return result; },
     order: (value: "asc" | "desc") => { direction = value; return result; },
     collect: async () => (tables[table] ?? []).filter(matches),
     first: async () => {
      const rows = (tables[table] ?? []).filter(matches);
      if (table === "hygglo_messages") rows.sort((a, b) => (a.hygglo_sent_at ?? 0) - (b.hygglo_sent_at ?? 0));
      if (direction === "desc") rows.reverse();
      return rows[0] ?? null;
     },
    };
    return result;
   },
   insert: async (table: string, row: Record<string, any>) => {
    const id = `${table}-${tables[table].length + 1}`;
    tables[table].push({ ...row, _id: id });
    return id;
   },
   patch: async (id: string, patch: Record<string, any>) => {
    const row = Object.values(tables).flat().find(candidate => candidate._id === id);
    if (!row) throw new Error(`Missing row ${id}`);
    Object.assign(row, patch);
   },
  };
  return { tables, ctx: { db } };
 }
 const claim = (ctx: unknown, args: Record<string, unknown>) => (__service_claimTestTurn as any)._handler(ctx, args);
 const base = { thread_id: "__probe__atomic", account_slug: "diogo", lease_token: "lease-00000001" };

 it("rejects a competing turn before it can strand a second transcript message", async () => {
  const f = harness();
  const first = await claim(f.ctx, { ...base, turn_id: "turn-00000001", renter_text: "First message" });
  expect(first).toMatchObject({ status: "claimed", requestMessageId: "__probe__atomic-turn-turn-00000001" });
  expect(f.tables.hygglo_messages).toHaveLength(1);
  expect(f.tables.renter_bot_lab_turns).toHaveLength(1);
  await expect(claim(f.ctx, { ...base, lease_token: "lease-00000002", turn_id: "turn-00000002", renter_text: "Competing message" }))
   .rejects.toThrow("A previous Lab turn is still running");
  expect(f.tables.hygglo_messages).toHaveLength(1);
  expect(f.tables.hygglo_messages[0].body_text).toBe("First message");
  expect(f.tables.renter_bot_lab_turns).toHaveLength(1);
 });

 it("replays the same turn without duplicating it and accepts fixture-seeded messages", async () => {
  const f = harness();
  const args = { ...base, turn_id: "turn-00000001", renter_text: "Same turn" };
  await claim(f.ctx, args);
  expect(await claim(f.ctx, { ...args, lease_token: "lease-00000002" })).toMatchObject({
   status: "running", requestMessageId: "__probe__atomic-turn-turn-00000001",
  });
  expect(f.tables.hygglo_messages).toHaveLength(1);

  const seeded = harness([{ _id: "seeded-message", thread_id: "__probe__atomic", account_slug: "diogo",
   message_id: "fixture-final-renter", sender: "renter", body_text: "Fixture prompt", hygglo_sent_at: 1 }]);
  const seededResult = await claim(seeded.ctx, { ...base, turn_id: "turn-fixture-0001", renter_text: "Fixture prompt", request_message_id: "fixture-final-renter" });
  expect(seededResult).toMatchObject({ status: "claimed", requestMessageId: "fixture-final-renter" });
  expect(seeded.tables.hygglo_messages).toHaveLength(1);
  expect(seeded.tables.renter_bot_lab_turns[0].renter_message_id).toBe("fixture-final-renter");
 });

 it("rejects a fixture message that is no longer latest before creating a turn", async () => {
  const f = harness([
   { _id: "old", thread_id: "__probe__atomic", account_slug: "diogo", message_id: "old-renter", sender: "renter", body_text: "Old", hygglo_sent_at: 1 },
   { _id: "new", thread_id: "__probe__atomic", account_slug: "diogo", message_id: "new-owner", sender: "owner", body_text: "Newer", hygglo_sent_at: 2 },
  ]);
  await expect(claim(f.ctx, { ...base, turn_id: "turn-stale-0001", renter_text: "Old", request_message_id: "old-renter" }))
   .rejects.toThrow("Lab turn no longer matches the latest renter message");
  expect(f.tables.renter_bot_lab_turns).toHaveLength(0);
 });
});
