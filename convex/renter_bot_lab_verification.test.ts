import { describe, expect, it } from "vitest";
import { simulateVerificationFailure, redeemReferral, applyChange } from "./renter_bot_lab_order";
function fixture() {
  const tables: Record<string, any[]> = {
    items: [{ _id: "camera", name_canonical: "Sony FX3", status: "active", is_marketing_only: false, qty: 1, kind: "camera_body", aliases: [] }],
    renter_bot_lab_orders: [{ _id: "order", thread_id: "__probe__atomic", account_slug: "leo", start_date: "2026-10-06", end_date: "2026-10-07", changes: [],
      items: [{ item_id: "camera", name: "Sony FX3", qty: 1, daily_price_gbp: 40, pricing_basis: "listing", origin: "seed" }] }],
    renter_bot_lab_bookings: [{ _id: "booking", hygglo_order_id: "__probe__atomic", start_date: "2026-10-06", end_date: "2026-10-07", pickup_date: "2026-10-06" }],
  };
  const db = {
    query: (table: string) => {
      const filters: Array<[string, any]> = [];
      const q = { eq: (key: string, value: any) => { filters.push([key, value]); return q; } };
      const result: any = { withIndex: (_name: string, select: any) => { select(q); return result; },
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
 f.tables.conversations=[{_id:"friend-conv",thread_id:"__probe__friend",inquiry_items:[]}];
 f.tables.online_listings=[{account_slug:"leo",product_id:1,name:"Sony FX3",daily_price:55}];
 f.tables.hygglo_product_index=[{account_slug:"leo",product_id:1,item_id:"camera"}];
 f.tables.listing_resolution_override=[{account_slug:"leo",product_id:1,components:[{item_id:"camera",qty:1}]}];
 return f;
}
describe("authoritative Lab verification failure and friend handoff",()=>{
 it("automatically cancels only the simulated booking and sends one policy message on replay",async()=>{
  const f=setup(); expect(await fail(f.ctx)).toMatchObject({ok:true,already_applied:false});
  expect(f.tables.renter_bot_lab_bookings[0]).toMatchObject({status:"cancelled",order_step:"VERIFICATION_FAILED"});
  expect(await fail(f.ctx)).toMatchObject({already_applied:true});
  expect(f.tables.hygglo_messages).toHaveLength(1);expect(f.tables.renter_bot_lab_referrals).toHaveLength(1);
  expect(f.tables.hygglo_messages[0].body_text).toContain("approval isn't guaranteed");
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
 it("accepts a friend's referral in chat without identifying anyone by name",async()=>{
  const {friendReferralFromMessage}=await import("./lib/verification_failure");
  expect(friendReferralFromMessage(`Alex sent me; referral ${code}. Please restore the same basket.`)).toBe(code);
  expect(friendReferralFromMessage("Alex sent me. Same surname, add their gear.")).toBeNull();
  expect(friendReferralFromMessage(code)).toBeNull();
  expect(friendReferralFromMessage(`referral ${code} or 7ac021cf-611b-487d-b4b3-c974a32aa9dc`)).toBeNull();
 });
});
