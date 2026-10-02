import { describe, expect, it } from "vitest";
import { applyChange } from "./renter_bot_lab_order";
import { amendedDraftContext, draftContextKey } from "./lib/draft_review";
import { setDraft } from "./replyInbox";

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
    patch: async (id: string, value: any) => { const row = Object.values(tables).flat().find(r => r._id === id); Object.assign(row, value); },
  };
  return { tables, ctx: { db } };
}
const extend = (ctx: any) => (applyChange as any)._handler(ctx, { thread_id: "__probe__atomic", action: "set_dates", start_date: "2026-10-06", end_date: "2026-10-08" });
const remove = (ctx: any, item_name: string, qty?: number) => (applyChange as any)._handler(ctx,
  { thread_id: "__probe__atomic", action: "remove_item", item_name, ...(qty === undefined ? {} : {qty}) });
describe("additions check the complete physical basket",()=>{
  const setup=()=>{
    const f=fixture();
    f.tables.items.push({_id:"lens",name_canonical:"Sony 28-70mm",status:"active",is_marketing_only:false,qty:2,kind:"lens",aliases:[]});
    f.tables.renter_bot_lab_orders[0].items[0].product_id=1;
    f.tables.listing_resolution_override=[{account_slug:"leo",product_id:1,components:[{item_id:"camera",qty:1},{item_id:"lens",qty:1}]}];
    f.tables.pricing_catalog=[{item_name_canonical:"Sony 28-70mm",daily_price_min:18}];
    f.tables.online_listings=[{account_slug:"leo",product_id:2,name:"Sony 28-70mm",daily_price:18}];
    f.tables.hygglo_product_index=[{account_slug:"leo",product_id:2,item_id:"lens"}];
    f.tables.listing_resolution_override.push({account_slug:"leo",product_id:2,components:[{item_id:"lens",qty:1}]});
    return f;
  };
  const add=(ctx:any,qty:number)=>(applyChange as any)._handler(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony 28-70mm",qty});
  it("quotes one extra with the full native basket and no writes or edit transition",async()=>{
    const {tables,ctx}=setup();const before=structuredClone(tables);
    const result=await (applyChange as any)._handler(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony 28-70mm",qty:1,preview_only:true});
    expect(result).toMatchObject({ok:true,preview_only:true,source:"native_lab_proposal",base_items:[{name:"Sony FX3",quantity:1}],added_items:[{name:"Sony 28-70mm",quantity:1}],quote:{total_gbp:116,days:2,lines:[expect.anything(),expect.objectContaining({name:"Sony 28-70mm",qty:1,line_total_gbp:36})]}});
    expect(result.context_transition).toBeUndefined();expect(tables).toEqual(before);
  });
  it("does not invent a dated proposal from a catalogue-only extra",async()=>{
    const {tables,ctx}=setup();tables.online_listings=[];tables.hygglo_product_index=[];tables.listing_resolution_override=tables.listing_resolution_override.filter(o=>o.product_id!==2);
    const before=structuredClone(tables);
    expect(await (applyChange as any)._handler(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony 28-70mm",qty:1,preview_only:true})).toMatchObject({ok:false});
    expect(tables).toEqual(before);
  });
  it("rejects an overallocated proposal without writes",async()=>{
    const {tables,ctx}=setup();const before=structuredClone(tables);
    expect(await (applyChange as any)._handler(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony 28-70mm",qty:2,preview_only:true})).toMatchObject({ok:false});expect(tables).toEqual(before);
  });
  it("rejects a partial priced proposal and a preview flag on another action",async()=>{
    const {tables,ctx}=setup();delete tables.renter_bot_lab_orders[0].items[0].daily_price_gbp;const before=structuredClone(tables);
    expect(await (applyChange as any)._handler(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony 28-70mm",preview_only:true})).toMatchObject({ok:false});
    expect(await (applyChange as any)._handler(ctx,{thread_id:"__probe__atomic",action:"remove_item",item_name:"Sony FX3",preview_only:true})).toMatchObject({ok:false});expect(tables).toEqual(before);
  });
  it("rejects two extras when the kit already needs one of the two free lenses",async()=>{
    const {tables,ctx}=setup();const before=structuredClone(tables);
    const result=await add(ctx,2);
    expect(result).toMatchObject({ok:false,stock_receipts:[expect.anything(),expect.objectContaining({item_name:"Sony 28-70mm",requested_units:3,free_units:2,available:false})]});
    expect(tables).toEqual(before);
  });
  it("accepts one extra with native aggregate evidence for both physical lenses",async()=>{
    const {tables,ctx}=setup();const result=await add(ctx,1);
    expect(result).toMatchObject({ok:true,stock_receipts:[expect.anything(),expect.objectContaining({item_name:"Sony 28-70mm",requested_units:2,free_units:2,available:true})]});
    expect(tables.renter_bot_lab_orders[0].items).toHaveLength(2);
    expect(tables.renter_bot_lab_orders[0].items[1]).toMatchObject({item_id:"lens",qty:1});
  });
  it("replays an addition once per inbound across reviewed aliases, while a new request can add more",async()=>{
    const {tables,ctx}=setup();tables.items.find(i=>i._id==="lens").qty=3;
    tables.items.find(i=>i._id==="lens").aliases=["Sony 28 70"];
    tables.hygglo_messages=[{thread_id:"__probe__atomic",message_id:"renter-1",fetched_at:1,_creationTime:1}];
    expect(await add(ctx,1)).toMatchObject({ok:true,action_performed:true});
    expect(await (applyChange as any)._handler(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony 28 70",qty:1,request_message_id:"renter-1"})).toMatchObject({ok:true,already_applied:true,action_performed:false});
    expect(tables.renter_bot_lab_orders[0].changes).toHaveLength(1);
    expect(tables.renter_bot_lab_orders[0].items[1].qty).toBe(1);
    tables.hygglo_messages.push({thread_id:"__probe__atomic",message_id:"renter-2",fetched_at:2,_creationTime:2});
    expect(await add(ctx,1)).toMatchObject({ok:true});
    expect(tables.renter_bot_lab_orders[0].changes).toHaveLength(2);
    expect(tables.renter_bot_lab_orders[0].items[1].qty).toBe(2);
  });
  it("never lets a delayed tool change the order after another inbound",async()=>{
    const {tables,ctx}=setup();tables.hygglo_messages=[{thread_id:"__probe__atomic",message_id:"new",fetched_at:2,_creationTime:2}];
    const before=structuredClone(tables);
    expect(await (applyChange as any)._handler(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony 28-70mm",request_message_id:"old"})).toMatchObject({ok:false,error_code:"stale_inbound"});
    expect(tables).toEqual(before);
  });
  it("does not add a free extra to an existing unmapped kit",async()=>{
    const {tables,ctx}=setup();tables.listing_resolution_override=[];
    tables.hygglo_products=[{accountSlug:"leo",productId:1,masterItemId:"camera",name:"Unmapped kit"}];
    const before=structuredClone(tables);expect(await add(ctx,1)).toMatchObject({ok:false});expect(tables).toEqual(before);
  });
});
describe("item removals preserve exact identity and quantity", () => {
  it("removes A7 II without removing A7 III", async () => {
    const { tables, ctx } = fixture();
    tables.items = [{_id:"ii",name_canonical:"Sony A7 II",aliases:["Sony A7 2"]},{_id:"iii",name_canonical:"Sony A7 III",aliases:["Sony A7 3"]}];
    tables.renter_bot_lab_orders[0].items = tables.items.map(i => ({ item_id:i._id,name:i.name_canonical,qty:1,daily_price_gbp:40,pricing_basis:"listing",origin:"seed" }));
    expect(await remove(ctx,"Sony A7 II")).toMatchObject({ok:true,order:{total_gbp:80,lines:[{name:"Sony A7 III",qty:1}]}});
    expect(tables.renter_bot_lab_orders[0].items).toHaveLength(1);
  });
  it("uses reviewed native aliases without matching incidental advertising models", async () => {
    const { tables, ctx } = fixture();
    tables.items[0].aliases=["FX 3"];
    tables.renter_bot_lab_orders[0].items[0].name="Sony FX3 (same sensor as Sony A7S III)";
    const before=structuredClone(tables);
    expect(await remove(ctx,"Sony A7S III")).toMatchObject({ok:false});
    expect(tables).toEqual(before);
    expect(await remove(ctx,"FX 3")).toMatchObject({ok:true,order:{lines:[]}});
  });
  it.each([undefined,1,2])("removes only the requested %s units, defaulting to one",async(qty)=>{
    const {tables,ctx}=fixture();tables.renter_bot_lab_orders[0].items[0].qty=3;
    const result=await remove(ctx,"Sony FX3",qty);
    expect(result).toMatchObject({ok:true,order:{lines:[{qty:3-(qty??1)}],total_gbp:80*(3-(qty??1))}});
  });
  it.each([0,-1,1.5,21,2])("rejects invalid or excessive quantity %s without writes",async(qty)=>{
    const {tables,ctx}=fixture();const before=structuredClone(tables);
    expect(await remove(ctx,"Sony FX3",qty)).toMatchObject({ok:false});expect(tables).toEqual(before);
  });
  it.each(["camera","Pyxis"])("does not treat an unresolved %s as an included kit item",async(name)=>{
    const {tables,ctx}=fixture();const before=structuredClone(tables);
    const result=await remove(ctx,name);
    expect(result).toMatchObject({ok:false});expect(result.error).not.toMatch(/tell the renter it's included/i);expect(tables).toEqual(before);
  });
  it("asks which variant when a model prefix identifies two order lines",async()=>{
    const {tables,ctx}=fixture();tables.renter_bot_lab_orders[0].items=[{name:"Sony A7 II",qty:1,origin:"seed"},{name:"Sony A7 III",qty:1,origin:"seed"}];
    const before=structuredClone(tables);expect(await remove(ctx,"Sony A7")).toMatchObject({ok:false});expect(tables).toEqual(before);
  });
  it.each(["completed","cancelled","returned","obsolete","canceled","declined","step:CANCELED","step:REVIEWED","step:VERIFICATION_FAILED"])("does not edit an already %s rental",async(state)=>{
    const {tables,ctx}=fixture();
    tables.items[0].qty=3;
    if(state==="returned")tables.renter_bot_lab_bookings[0].return_date="2026-10-07";
    else if(state==="obsolete")tables.renter_bot_lab_bookings[0].is_obsolete=true;
    else if(state.startsWith("step:"))tables.renter_bot_lab_bookings[0].order_step=state.slice(5);
    else tables.renter_bot_lab_bookings[0].status=state;
    const before=structuredClone(tables);
    expect(await remove(ctx,"Sony FX3")).toMatchObject({ok:false});
    expect(await (applyChange as any)._handler(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony FX3"})).toMatchObject({ok:false});
    expect(tables).toEqual(before);
  });
});
describe("date amendments validate stock before writing", () => {
  it("leaves both records and physical pickup facts untouched on a blocked extra day", async () => {
    const { tables, ctx } = fixture();
    tables.owner_unavailability = [{ item_id: "camera", start_date: "2026-10-08", end_date: "2026-10-08" }];
    const before = structuredClone(tables);
    expect(await extend(ctx)).toMatchObject({ ok: false });
    expect(tables).toEqual(before);
  });
  it("commits an available date change with a real stock receipt and preserves pickup facts", async () => {
    const { tables, ctx } = fixture();
    const beforeKey = draftContextKey(tables.renter_bot_lab_bookings[0], [], tables.renter_bot_lab_orders[0]);
    const result = await extend(ctx);
    expect(result).toMatchObject({ ok: true, order: { days: 3, total_gbp: 120 }, stock_receipts: [{ available: true, start_date: "2026-10-06", end_date: "2026-10-08", requested_units: 1 }] });
    expect(tables.renter_bot_lab_orders[0].end_date).toBe("2026-10-08");
    expect(tables.renter_bot_lab_bookings[0]).toMatchObject({ end_date: "2026-10-08", pickup_date: "2026-10-06" });
    const afterKey = draftContextKey(tables.renter_bot_lab_bookings[0], [], tables.renter_bot_lab_orders[0]);
    expect(amendedDraftContext(beforeKey, "__probe__atomic", [result.context_transition])).toBe(afterKey);
  });
  it("aggregates shared physical components across separately rentable kit lines", async () => {
    const { tables, ctx } = fixture();
    tables.items.push({ _id: "camera2", name_canonical: "Sony A7 V", status: "active", qty: 1, kind: "camera_body" }, { _id: "lens", name_canonical: "Sony GM 24-70", status: "active", qty: 1, kind: "lens" });
    tables.renter_bot_lab_orders[0].items = [{ product_id: 1, item_id: "camera", name: "FX3 kit", qty: 1, origin: "seed" }, { product_id: 2, item_id: "camera2", name: "A7 V kit", qty: 1, origin: "seed" }];
    tables.listing_resolution_override = [1, 2].map(product_id => ({ account_slug: "leo", product_id, components: [{ item_id: product_id === 1 ? "camera" : "camera2", qty: 1 }, { item_id: "lens", qty: 1 }] }));
    const before = structuredClone(tables);
    expect(await extend(ctx)).toMatchObject({ ok: false });
    expect(tables).toEqual(before);
  });
  it("does not let a free primary body prove an unmapped listing kit", async () => {
    const { tables, ctx } = fixture();
    tables.renter_bot_lab_orders[0].items[0].product_id = 1;
    tables.hygglo_products = [{ accountSlug: "leo", productId: 1, masterItemId: "camera", name: "Unmapped kit" }];
    expect(await extend(ctx)).toMatchObject({ ok: false });
    expect(tables.renter_bot_lab_orders[0].changes).toEqual([]);
  });
  it("does not claim to validate a date change for an empty basket", async () => {
    const { tables, ctx } = fixture(); tables.renter_bot_lab_orders[0].items = [];
    expect(await extend(ctx)).toMatchObject({ ok: false });
  });
  it("does not move a collected rental's start date or edit an already returned rental", async () => {
    const { tables, ctx } = fixture();
    expect(await (applyChange as any)._handler(ctx, { thread_id: "__probe__atomic", action: "set_dates", start_date: "2026-10-07", end_date: "2026-10-08" })).toMatchObject({ ok: false });
    tables.renter_bot_lab_bookings[0].return_date = "2026-10-07";
    expect(await extend(ctx)).toMatchObject({ ok: false });
    expect(tables.renter_bot_lab_orders[0].changes).toEqual([]);
  });
});

describe("amended drafts retain atomic cache safety", () => {
  const setup = async () => {
    const f = fixture();
    f.tables.conversations = [{ _id: "conversation", thread_id: "__probe__atomic" }];
    f.tables.settings = [{ _id: "settings", draft_epoch: 20 }];
    f.tables.hygglo_messages = [{ message_id: "renter-1", thread_id: "__probe__atomic", fetched_at: 1, _creationTime: 1 }];
    const before = draftContextKey(f.tables.renter_bot_lab_bookings[0], [], f.tables.renter_bot_lab_orders[0]);
    const result = await extend(f.ctx);
    const key = amendedDraftContext(before, "__probe__atomic", [result.context_transition]);
    return { ...f, args: { thread_id: "__probe__atomic", message_id: "renter-1", epoch: 20,
      context_key: key, draft_text: "Your new total is £120." } };
  };
  it("saves the reply against the actual native amended order", async () => {
    const { tables, ctx, args } = await setup();
    expect(await (setDraft as any)._handler(ctx, args)).toMatchObject({ ok: true });
    expect(tables.conversations[0]).toMatchObject({ ai_draft_text: args.draft_text, ai_draft_context_key: args.context_key });
  });
  it.each(["inbound", "epoch", "owner-date", "owner-quantity", "owner-price"])("rejects an intervening %s change", async (change) => {
    const { tables, ctx, args } = await setup();
    if (change === "inbound") tables.hygglo_messages.push({ message_id: "renter-2", thread_id: "__probe__atomic", fetched_at: 2, _creationTime: 2 });
    if (change === "epoch") tables.settings[0].draft_epoch++;
    if (change === "owner-date") tables.renter_bot_lab_orders[0].end_date = "2026-10-09";
    if (change === "owner-quantity") tables.renter_bot_lab_orders[0].items[0].qty = 2;
    if (change === "owner-price") tables.renter_bot_lab_orders[0].items[0].daily_price_gbp = 60;
    expect(await (setDraft as any)._handler(ctx, args)).toMatchObject({ ok: false });
    expect(tables.conversations[0].ai_draft_text).toBeUndefined();
  });
});

it("replayed removals cannot decrement the quantity twice",async()=>{
 const {tables,ctx}=fixture();tables.items[0].aliases=["FX 3"];
 tables.renter_bot_lab_orders[0].items[0].qty=3;
 tables.hygglo_messages=[{thread_id:"__probe__atomic",message_id:"renter-1",fetched_at:1,_creationTime:1}];
 expect(await remove(ctx,"Sony FX3",1)).toMatchObject({ok:true});
 expect(await remove(ctx,"FX 3",1)).toMatchObject({ok:true,already_applied:true,order:{lines:[expect.objectContaining({qty:2})]}});
 expect(tables.renter_bot_lab_orders[0].changes).toHaveLength(1);
});
it("unchanged dates create no extra revision even without a message key",async()=>{
 const {tables,ctx}=fixture();
 expect(await extend(ctx)).toMatchObject({ok:true,action_performed:true});
 const replay=await extend(ctx);
 expect(replay).toMatchObject({ok:true,already_applied:true,action_performed:false});
 expect(replay.applied).toBeUndefined();expect(replay.context_transition).toBeUndefined();
 expect(tables.renter_bot_lab_orders[0].changes).toHaveLength(1);
});

it("replay history cannot claim that a removed item was added again",async()=>{
 const {tables,ctx}=fixture();tables.items[0].qty=3;tables.renter_bot_lab_orders[0].items[0].qty=3;
 tables.hygglo_messages=[{thread_id:"__probe__atomic",message_id:"renter-1",fetched_at:1,_creationTime:1}];
 expect(await remove(ctx,"Sony FX3",1)).toMatchObject({ok:true,action_performed:true});
 // Another edit under the same inbound can alter the current order independently.
 expect(await remove(ctx,"Sony FX3",2)).toMatchObject({ok:true,action_performed:true});
 const replay=await remove(ctx,"Sony FX3",1);
 expect(replay).toMatchObject({ok:true,action_performed:false,already_applied:true,order:{lines:[]}});
 expect(replay.applied).toBeUndefined();expect(replay.context_transition).toBeUndefined();
 expect(tables.renter_bot_lab_orders[0].changes).toHaveLength(2);
});


describe("commercial offering identity and marginal quotes",()=>{
 const setup=()=>{
  const f=fixture();f.tables.items[0].qty=3;
  f.tables.items.push({_id:"lens",name_canonical:"Sony 28-70mm",status:"active",is_marketing_only:false,qty:1,kind:"lens"});
  f.tables.renter_bot_lab_orders[0].items[0].product_id=1;
  f.tables.listing_resolution_override=[{account_slug:"leo",product_id:1,components:[{item_id:"camera",qty:1},{item_id:"lens",qty:1}]},{account_slug:"leo",product_id:3,components:[{item_id:"camera",qty:1}]}];
  f.tables.hygglo_product_index=[{account_slug:"leo",product_id:3,item_id:"camera"}];
  f.tables.online_listings=[{account_slug:"leo",product_id:3,name:"Sony FX3 body",daily_price:20}];
  return f;
 };
 const preview=(ctx:any)=>(applyChange as any)._handler(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony FX3",qty:1,preview_only:true});
 it("adds a body separately instead of multiplying the already-booked lens kit",async()=>{
  const {ctx,tables}=setup();const before=structuredClone(tables);const p=await preview(ctx);
  expect(p).toMatchObject({ok:true,additional_cost_gbp:40,base_quote:{total_gbp:80},addition_quote:{total_gbp:40},quote:{total_gbp:120,lines:[{product_id:1,qty:1,daily_price_gbp:40},{product_id:3,qty:1,daily_price_gbp:20}]}});
  expect(p.stock_receipts.find((r:any)=>r.item_name==="Sony 28-70mm")).toMatchObject({requested_units:1});expect(tables).toEqual(before);
 });
 it("proves one extra's marginal cost even when an identical body line merges",async()=>{
  const {ctx,tables}=setup();Object.assign(tables.renter_bot_lab_orders[0].items[0],{product_id:3,daily_price_gbp:20});
  const before=structuredClone(tables);const p=await preview(ctx);
  expect(p).toMatchObject({ok:true,additional_cost_gbp:40,base_quote:{total_gbp:40},addition_quote:{total_gbp:40,lines:[{qty:1}]},quote:{total_gbp:80,lines:[{product_id:3,qty:2}]}});expect(tables).toEqual(before);
 });
 it("keeps a booked rate intact while pricing the extra from current native terms",async()=>{
  const {ctx,tables}=setup();Object.assign(tables.renter_bot_lab_orders[0].items[0],{product_id:3,daily_price_gbp:30});
  const p=await preview(ctx);expect(p).toMatchObject({ok:true,additional_cost_gbp:40,base_quote:{total_gbp:60},quote:{total_gbp:100,lines:[{qty:1,daily_price_gbp:30},{qty:1,daily_price_gbp:20}]}});
 });
});
