import { describe, expect, it } from "vitest";
import { applyChange, applyAdditionBasket, quoteAdditionBasket } from "./renter_bot_lab_order";
import { amendedDraftContext, draftContextKey } from "./lib/draft_review";
import { getBotBooking, getLabOrder } from "./lib/renter_booking";
import { setDraft } from "./replyInbox";
import { renterToolReceipts } from "../src/lib/renter-tool-evidence";
import { renterPriceEvidence } from "../src/lib/renter-price-evidence";

function fixture() {
  const tables: Record<string, any[]> = {
    hygglo_messages: [{ thread_id:"__probe__atomic", message_id:"fixture-current", sender:"renter", body_text:"Please extend the return to 8 October at £120 total.", fetched_at:1, _creationTime:1 }],
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
// Mirror the canonical server caller: attach the actual latest inbound ID.
// Boundary tests below deliberately bypass this helper to exercise missing IDs.
async function applyCurrentChange(ctx:any,args:any) {
  const messages=await ctx.db.query("hygglo_messages").withIndex("by_thread",(q:any)=>q.eq("thread_id",args.thread_id)).collect();
  const latest=messages.at(-1);
  return (applyChange as any)._handler(ctx,{...args,...(!args.preview_only && args.request_message_id===undefined ? {request_message_id:latest?.message_id}: {})});
}
const extend = (ctx: any) => applyCurrentChange(ctx, { thread_id: "__probe__atomic", action: "set_dates", start_date: "2026-10-06", end_date: "2026-10-08" });
const remove = (ctx: any, item_name: string, qty?: number) => applyCurrentChange(ctx,
  { thread_id: "__probe__atomic", action: "remove_item", item_name, ...(qty === undefined ? {} : {qty}) });
describe("additions check the complete physical basket",()=>{
  const setup=()=>{
    const f=fixture(); f.tables.items[0].lens_mount="E";
    f.tables.items.push({_id:"lens",name_canonical:"Sony 28-70mm",status:"active",is_marketing_only:false,qty:2,kind:"lens",lens_mount:"E",aliases:[]});
    f.tables.renter_bot_lab_orders[0].items[0].product_id=1;
    f.tables.listing_resolution_override=[{account_slug:"leo",product_id:1,components:[{item_id:"camera",qty:1},{item_id:"lens",qty:1}]}];
    f.tables.pricing_catalog=[{item_name_canonical:"Sony 28-70mm",daily_price_min:18}];
    f.tables.online_listings=[{account_slug:"leo",product_id:2,name:"Sony 28-70mm",daily_price:18}];
    f.tables.hygglo_product_index=[{account_slug:"leo",product_id:2,item_id:"lens"}];
    f.tables.listing_resolution_override.push({account_slug:"leo",product_id:2,components:[{item_id:"lens",qty:1}]});
    f.tables.hygglo_messages[0].body_text="Please add the Sony 28-70mm at £36 extra.";
    return f;
  };
  const add=(ctx:any,qty:number)=>applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony 28-70mm",qty});
  const exactSetup=()=>{
    const f=setup();f.tables.items[0].qty=3;
    f.tables.online_listings.push({account_slug:"leo",product_id:3,name:"Sony FX3 and 28-70mm kit",daily_price:60},{account_slug:"leo",product_id:4,name:"Sony FX3 body",daily_price:45});
    f.tables.hygglo_product_index.push({account_slug:"leo",product_id:4,item_id:"camera"});
    f.tables.listing_resolution_override.push({account_slug:"leo",product_id:3,components:[{item_id:"camera",qty:1},{item_id:"lens",qty:1}]},{account_slug:"leo",product_id:4,components:[{item_id:"camera",qty:1}]});
    return f;
  };
  it("preserves the exact selected kit price and both physical components in a read-only quote",async()=>{
    const {tables,ctx}=exactSetup();const before=structuredClone(tables);
    const result=await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony FX3 and 28-70mm kit",product_id:3,qty:1,preview_only:true});
    expect(result).toMatchObject({ok:true,additional_cost_gbp:120,quote:{total_gbp:200},addition_quote:{lines:[expect.objectContaining({product_id:3,qty:1,daily_price_gbp:60})]}});
    expect(result.stock_receipts).toEqual(expect.arrayContaining([expect.objectContaining({item_name:"Sony FX3",requested_units:2}),expect.objectContaining({item_name:"Sony 28-70mm",requested_units:2})]));
    expect(tables).toEqual(before);
  });
  it("rejects the exact kit when its shared lens is already consumed by the current booking",async()=>{
    const {tables,ctx}=exactSetup();tables.items.find(i=>i._id==="lens").qty=1;const before=structuredClone(tables);
    expect(await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony FX3 kit",product_id:3,preview_only:true})).toMatchObject({ok:false,stock_receipts:expect.arrayContaining([expect.objectContaining({item_name:"Sony 28-70mm",requested_units:2,available:false})])});
    expect(tables).toEqual(before);
  });
  it("does not quote another account's listing or an unowned mapping",async()=>{
    const {tables,ctx}=exactSetup();const before=structuredClone(tables);
    expect(await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"FX3 kit",product_id:999,preview_only:true})).toMatchObject({ok:false});
    expect(tables).toEqual(before);
    tables.listing_resolution_override.find(r=>r.product_id===3).components=[];
    expect(await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"FX3 kit",product_id:3,preview_only:true})).toMatchObject({ok:false});
  });
  it("does not replay a body addition when a retry switches between canonical name and exact product ID",async()=>{
    const {tables,ctx}=exactSetup();tables.hygglo_messages=[{thread_id:"__probe__atomic",message_id:"one-request",sender:"renter",body_text:"Please add one extra Sony FX3 at £90 extra."}];
    const args={thread_id:"__probe__atomic",action:"add_item",item_name:"Sony FX3",qty:1,request_message_id:"one-request"};
    expect(await applyCurrentChange(ctx,args)).toMatchObject({ok:true,action_performed:true});
    expect(await applyCurrentChange(ctx,{...args,product_id:4})).toMatchObject({ok:true,already_applied:true,action_performed:false});
    expect(tables.renter_bot_lab_orders[0].changes).toHaveLength(1);
  });
  it("recognizes a request already recorded by the previous physical-ID ledger format",async()=>{
    const {tables,ctx}=exactSetup();tables.hygglo_messages=[{thread_id:"__probe__atomic",message_id:"legacy-request",sender:"renter",body_text:"Please add one extra Sony FX3 at £90 extra."}];
    tables.renter_bot_lab_orders[0].changes=[{at:1,summary:"added 1x Sony FX3",request_key:JSON.stringify(["legacy-request","add_item","camera",1])}];
    const before=structuredClone(tables);
    expect(await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony FX3",product_id:4,qty:1,request_message_id:"legacy-request"})).toMatchObject({ok:true,already_applied:true,action_performed:false});
    expect(tables).toEqual(before);
  });
  it("quotes one extra with the full native basket and no writes or edit transition",async()=>{
    const {tables,ctx}=setup();const before=structuredClone(tables);
    const result=await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony 28-70mm",qty:1,preview_only:true});
    expect(result).toMatchObject({ok:true,preview_only:true,source:"native_lab_proposal",base_items:[{name:"Sony FX3",quantity:1}],added_items:[{name:"Sony 28-70mm",quantity:1}],quote:{total_gbp:116,days:2,lines:[expect.anything(),expect.objectContaining({name:"Sony 28-70mm",qty:1,line_total_gbp:36})]}});
    expect(result.context_transition).toBeUndefined();expect(tables).toEqual(before);
  });
  it("does not invent a dated proposal from a catalogue-only extra",async()=>{
    const {tables,ctx}=setup();tables.online_listings=[];tables.hygglo_product_index=[];tables.listing_resolution_override=tables.listing_resolution_override.filter(o=>o.product_id!==2);
    const before=structuredClone(tables);
    expect(await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony 28-70mm",qty:1,preview_only:true})).toMatchObject({ok:false});
    expect(tables).toEqual(before);
  });
  it("rejects an overallocated proposal without writes",async()=>{
    const {tables,ctx}=setup();const before=structuredClone(tables);
    expect(await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony 28-70mm",qty:2,preview_only:true})).toMatchObject({ok:false});expect(tables).toEqual(before);
  });
  it("rejects a partial priced proposal and a preview flag on another action",async()=>{
    const {tables,ctx}=setup();delete tables.renter_bot_lab_orders[0].items[0].daily_price_gbp;const before=structuredClone(tables);
    expect(await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony 28-70mm",preview_only:true})).toMatchObject({ok:false});
    expect(await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"remove_item",item_name:"Sony FX3",preview_only:true})).toMatchObject({ok:false});expect(tables).toEqual(before);
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
    tables.hygglo_messages=[{thread_id:"__probe__atomic",message_id:"renter-1",sender:"renter",body_text:"Please add the Sony 28-70mm at £36 extra.",fetched_at:1,_creationTime:1}];
    expect(await add(ctx,1)).toMatchObject({ok:true,action_performed:true});
    expect(await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony 28 70",qty:1,request_message_id:"renter-1"})).toMatchObject({ok:true,already_applied:true,action_performed:false});
    expect(tables.renter_bot_lab_orders[0].changes).toHaveLength(1);
    expect(tables.renter_bot_lab_orders[0].items[1].qty).toBe(1);
    tables.hygglo_messages.push({thread_id:"__probe__atomic",message_id:"renter-2",sender:"renter",body_text:"Please add the Sony 28-70mm at £36 extra.",fetched_at:2,_creationTime:2});
    expect(await add(ctx,1)).toMatchObject({ok:true});
    expect(tables.renter_bot_lab_orders[0].changes).toHaveLength(2);
    expect(tables.renter_bot_lab_orders[0].items[1].qty).toBe(2);
  });
  it("never lets a delayed tool change the order after another inbound",async()=>{
    const {tables,ctx}=setup();tables.hygglo_messages=[{thread_id:"__probe__atomic",message_id:"new",fetched_at:2,_creationTime:2}];
    const before=structuredClone(tables);
    expect(await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony 28-70mm",request_message_id:"old"})).toMatchObject({ok:false,error_code:"stale_inbound"});
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
    tables.renter_bot_lab_orders[0].items[0].product_id=1;
    tables.items = [{_id:"ii",name_canonical:"Sony A7 II",aliases:["Sony A7 2"]},{_id:"iii",name_canonical:"Sony A7 III",aliases:["Sony A7 3"]}];
    tables.renter_bot_lab_orders[0].items = tables.items.map(i => ({ product_id:i._id==="ii"?1:2,item_id:i._id,name:i.name_canonical,qty:1,daily_price_gbp:40,pricing_basis:"listing",origin:"seed" }));
    tables.hygglo_messages[0].body_text="Please remove Sony A7 II.";
    expect(await remove(ctx,"Sony A7 II")).toMatchObject({ok:true,order:{total_gbp:80,lines:[{name:"Sony A7 III",qty:1}]}});
    expect(tables.renter_bot_lab_orders[0].items).toHaveLength(1);
  });
  it("uses reviewed native aliases without matching incidental advertising models", async () => {
    const { tables, ctx } = fixture();
    tables.renter_bot_lab_orders[0].items[0].product_id=1;
    tables.items[0].aliases=["FX 3"];
    tables.renter_bot_lab_orders[0].items[0].name="Sony FX3 (same sensor as Sony A7S III)";
    tables.hygglo_messages[0].body_text="Please remove FX 3.";
    const before=structuredClone(tables);
    expect(await remove(ctx,"Sony A7S III")).toMatchObject({ok:false});
    expect(tables).toEqual(before);
    expect(await remove(ctx,"FX 3")).toMatchObject({ok:true,order:{lines:[]}});
  });
  it.each([undefined,1,2])("removes only the requested %s units, defaulting to one",async(qty)=>{
    const {tables,ctx}=fixture();tables.renter_bot_lab_orders[0].items[0].qty=3;
    tables.renter_bot_lab_orders[0].items[0].product_id=1;
    tables.hygglo_messages[0].body_text=`Please remove ${qty??1} Sony FX3.`;
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
    expect(await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony FX3"})).toMatchObject({ok:false});
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
    expect(await applyCurrentChange(ctx, { thread_id: "__probe__atomic", action: "set_dates", start_date: "2026-10-07", end_date: "2026-10-08" })).toMatchObject({ ok: false });
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
    f.tables.hygglo_messages = [{ message_id: "renter-1", thread_id: "__probe__atomic", sender:"renter", body_text:"Please extend the return to 8 October at £120 total.", fetched_at: 1, _creationTime: 1 }];
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
 tables.renter_bot_lab_orders[0].items[0].product_id=1;
 tables.hygglo_messages=[{thread_id:"__probe__atomic",message_id:"renter-1",sender:"renter",body_text:"Please remove one Sony FX3.",fetched_at:1,_creationTime:1}];
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
 tables.renter_bot_lab_orders[0].items[0].product_id=1;
 tables.hygglo_messages=[{thread_id:"__probe__atomic",message_id:"renter-1",sender:"renter",body_text:"Please remove one Sony FX3.",fetched_at:1,_creationTime:1}];
 expect(await remove(ctx,"Sony FX3",1)).toMatchObject({ok:true,action_performed:true});
 // A separate owner edit alters current state; the original inbound cannot authorise a different quantity.
 await ctx.db.patch("order",{items:[],changes:[...tables.renter_bot_lab_orders[0].changes,{at:2,summary:"owner removed remaining units"}]});
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
 const preview=(ctx:any)=>applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony FX3",qty:1,preview_only:true});
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

it("blocks every mistaken edit against a quote-only renter message without writing",async()=>{
 const {ctx,tables}=fixture();
 tables.hygglo_messages=[{thread_id:"__probe__atomic",message_id:"quote",sender:"renter",body_text:"Could you quote an extra Sony FX3? Quote only, don't change my booking.",fetched_at:1,_creationTime:1}];
 const before=structuredClone(tables);
 for(const action of ["add_item","remove_item","set_dates"]){
  expect(await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action,item_name:"Sony FX3",qty:1,start_date:"2026-10-08",end_date:"2026-10-09",request_message_id:"quote"})).toMatchObject({ok:false,action_performed:false,error_code:"renter_requested_read_only"});
  expect(tables).toEqual(before);
 }
});

function setupAtomicAddition(){
 const f=fixture();
 f.tables.items=[{_id:"camera",name_canonical:"BMPCC 6K Full Frame",kind:"camera_body",lens_mount:"L",status:"active",qty:1,aliases:[]},
 {_id:"lens",name_canonical:"Anamorphic Blazar Remus 100mm",kind:"lens",lens_mount:"PL",status:"active",qty:1,aliases:[]},
 {_id:"adapter",name_canonical:"PL to L mount",kind:"accessory",status:"active",qty:1,aliases:[]}];
 const row=f.tables.renter_bot_lab_orders[0];row.start_date="2026-10-20";row.end_date="2026-10-21";row.items=[{product_id:1,name:"BMPCC 6K Full Frame",qty:1,daily_price_gbp:62,pricing_basis:"listing",origin:"seed"}];
 Object.assign(f.tables.renter_bot_lab_bookings[0],{start_date:row.start_date,end_date:row.end_date,pickup_date:undefined,status:"confirmed"});
 f.tables.online_listings=[{account_slug:"leo",product_id:1,name:"BMPCC 6K Full Frame",daily_price:62},{account_slug:"leo",product_id:2,name:"Blazar Remus 100mm",daily_price:25},{account_slug:"leo",product_id:3,name:"PL to L mount",daily_price:10}];
 f.tables.listing_resolution_override=f.tables.items.map((item,i)=>({account_slug:"leo",product_id:i+1,components:[{item_id:item._id,qty:1}]}));
 f.tables.hygglo_messages=[{thread_id:"__probe__atomic",message_id:"renter-current",sender:"renter",body_text:"Please add the Blazar Remus 100mm and your PL to L mount adapter together for £70 extra.",fetched_at:1,_creationTime:1}];
 return f;
}
const applyBasket=(ctx:any,items=[{product_id:2,qty:1},{product_id:3,qty:1}],request_message_id="renter-current")=>(applyAdditionBasket as any)._handler(ctx,{thread_id:"__probe__atomic",request_message_id,items});
describe("complete setup acceptance is one transaction",()=>{
 it("commits every required component, native total and one revision together",async()=>{
  const {tables,ctx}=setupAtomicAddition();const result=await applyBasket(ctx);
  expect(result).toMatchObject({ok:true,action_performed:true,order:{total_gbp:194},context_transition:{source:"native_lab_amendment",before_revision:0,after_revision:1}});
  expect(tables.renter_bot_lab_orders[0].items.map((i:any)=>i.product_id)).toEqual([1,2,3]);expect(tables.renter_bot_lab_orders[0].changes).toHaveLength(1);
  const receipts=renterToolReceipts([{toolName:"modify_booking",toolCallId:"actual-acceptance",result}]);
  const prices=renterPriceEvidence(receipts,[],"__probe__atomic");
  expect(prices).toEqual(expect.arrayContaining([expect.objectContaining({kind:"basket",total_gbp:194}),expect.objectContaining({kind:"basket",quote_role:"addition",total_gbp:70}),expect.objectContaining({kind:"rental",total_gbp:50}),expect.objectContaining({kind:"rental",total_gbp:20})]));
  expect(renterPriceEvidence(renterToolReceipts([{toolName:"modify_booking",result:{...result,action_performed:false}}]),[],"__probe__atomic")).toEqual([]);

 });
 it("does not commit the first item when the later item has no verified mapping or stock",async()=>{
  for(const items of [[{product_id:2,qty:1},{product_id:999,qty:1}],[{product_id:2,qty:1},{product_id:3,qty:2}]]){
   const {tables,ctx}=setupAtomicAddition();const before=structuredClone(tables);expect(await applyBasket(ctx,items)).toMatchObject({ok:false,action_performed:false});expect(tables).toEqual(before);
  }
 });
 it("refuses a lens-only acceptance that omits its required owner-supplied adapter",async()=>{
  const {tables,ctx}=setupAtomicAddition();const before=structuredClone(tables);
  expect(await applyBasket(ctx,[{product_id:2,qty:1}])).toMatchObject({ok:false,error_code:"complete_setup_required"});
  expect(await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"add_item",product_id:2,item_name:"Blazar Remus 100mm",qty:1})).toMatchObject({ok:false,error_code:"complete_setup_required"});expect(tables).toEqual(before);
 });
 it("accepts the lens alone when the renter supplies its explicitly matching adapter",async()=>{
  const {tables,ctx}=setupAtomicAddition();tables.hygglo_messages[0].body_text="I already have my own PL-to-L mount adapter. Please add the Blazar Remus 100mm at £50 extra.";
  expect(await applyBasket(ctx,[{product_id:2,qty:1}])).toMatchObject({ok:true,order:{total_gbp:174}});expect(tables.renter_bot_lab_orders[0].items).toHaveLength(2);
 });
 it("retries the same complete request once regardless of selection ordering",async()=>{
  const {tables,ctx}=setupAtomicAddition();expect(await applyBasket(ctx)).toMatchObject({ok:true,action_performed:true});
  expect(await applyBasket(ctx,[{product_id:3,qty:1},{product_id:2,qty:1}])).toMatchObject({ok:true,already_applied:true,action_performed:false,order:{total_gbp:194}});expect(tables.renter_bot_lab_orders[0].changes).toHaveLength(1);
 });
 it("preserves readonly intent and rejects stale, missing or owner message scope",async()=>{
  for(const variant of ["readonly","stale","missing","owner"]){const {tables,ctx}=setupAtomicAddition();if(variant==="readonly")tables.hygglo_messages[0].body_text="Please quote only, don't change my booking.";if(variant==="owner")tables.hygglo_messages[0].sender="owner";
   const before=structuredClone(tables);expect(await applyBasket(ctx,undefined,variant==="stale"?"older":variant==="missing"?"":"renter-current")).toMatchObject({ok:false,action_performed:false});expect(tables).toEqual(before);}
 });
 it("does not add a complete setup to a cancelled rental or any real thread",async()=>{
  const {tables,ctx}=setupAtomicAddition();tables.renter_bot_lab_bookings[0].status="cancelled";const before=structuredClone(tables);expect(await applyBasket(ctx)).toMatchObject({ok:false,action_performed:false});expect(tables).toEqual(before);
  await expect((applyAdditionBasket as any)._handler(ctx,{thread_id:"real-rental",request_message_id:"renter-current",items:[{product_id:2,qty:1}]})).rejects.toThrow("refusing a real");
 });
});

describe("Native target restrictions protect actual booking changes",()=>{
 it("refuses conflicting complete additions without changing the order",async()=>{
  const {tables,ctx}=setupAtomicAddition();tables.hygglo_messages[0].body_text="Please don't add the Blazar Remus 100mm or the PL to L mount adapter. Keep the existing camera booking.";const before=structuredClone(tables);
  expect(await applyBasket(ctx)).toMatchObject({ok:false,action_performed:false,error_code:"renter_prohibited_item"});expect(tables).toEqual(before);
 });
 it("also protects the legacy single-add path from a named adapter restriction",async()=>{
  const {tables,ctx}=setupAtomicAddition();tables.hygglo_messages[0].body_text="Don't add the PL to L mount adapter.";const before=structuredClone(tables);
  expect(await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"add_item",product_id:3,item_name:"PL to L mount",qty:1})).toMatchObject({ok:false,error_code:"renter_prohibited_item"});expect(tables).toEqual(before);
 });
 it("preserves the accepted lens when the renter forbids adding an adapter they supply",async()=>{
  const {tables,ctx}=setupAtomicAddition();tables.hygglo_messages[0].body_text="Don't add your PL to L mount adapter. I already have my own PL-to-L mount adapter. Please add the Blazar Remus 100mm at £50 extra.";
  expect(await applyBasket(ctx,[{product_id:2,qty:1}])).toMatchObject({ok:true,order:{total_gbp:174}});
 });
 it("refuses removal of the exact protected booked model",async()=>{
  const {tables,ctx}=setupAtomicAddition();tables.hygglo_messages[0].body_text="Don't remove my Blackmagic 6K Full Frame.";const before=structuredClone(tables);
  expect(await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"remove_item",product_id:1,item_name:"BMPCC 6K Full Frame",qty:1})).toMatchObject({ok:false,error_code:"renter_prohibited_item"});expect(tables).toEqual(before);
 });
});


describe("legacy edits require a live renter inbound",()=>{
  for(const action of ["add_item","remove_item","set_dates"] as const){
    for(const variant of ["missing_id","empty_id","stale_id","owner_latest","no_message"]){
      it(`${action} refuses ${variant} before changing the basket or booking`,async()=>{
        const {tables,ctx}=fixture();
        if(variant==="owner_latest")tables.hygglo_messages[0].sender="owner";
        if(variant==="no_message")tables.hygglo_messages=[];
        const before=structuredClone(tables);
        const request_message_id=variant==="missing_id"?undefined:variant==="empty_id"?"":variant==="stale_id"?"older-message":"fixture-current";
        const result=await (applyChange as any)._handler(ctx,{thread_id:"__probe__atomic",action,item_name:"Sony FX3",qty:1,start_date:"2026-10-06",end_date:"2026-10-08",...(request_message_id===undefined?{}:{request_message_id})});
        expect(result).toMatchObject({ok:false,action_performed:false,error_code:"stale_inbound"});
        expect(tables).toEqual(before);
      });
    }
  }
});


describe("additions reconcile real requests and sent quote terms",()=>{
 const offer=async(f:ReturnType<typeof setupAtomicAddition>)=>{
  const q=await (quoteAdditionBasket as any)._handler(f.ctx,{thread_id:"__probe__atomic",items:[{product_id:2,qty:1},{product_id:3,qty:1}]});
  const context=draftContextKey(await getBotBooking(f.ctx as any,"__probe__atomic"),undefined,await getLabOrder(f.ctx as any,"__probe__atomic"));
  const proposal={physical_identity_key:q.physical_identity_key,context_key:context,epoch:82,quoted_for_message_id:"earlier-renter",items:[{product_id:2,qty:1},{product_id:3,qty:1}],base_items:q.base_items,added_items:q.added_items,start_date:q.quote.start_date,end_date:q.quote.end_date,total_gbp:q.quote.total_gbp,additional_cost_gbp:q.additional_cost_gbp};
  f.tables.hygglo_messages[0].fetched_at=2;f.tables.hygglo_messages[0]._creationTime=2;
  f.tables.hygglo_messages.unshift({thread_id:"__probe__atomic",message_id:"owner-offer",sender:"owner",account_slug:"leo",body_text:"The Blazar Remus 100mm and PL to L mount cost £70 extra for 20–21 October, bringing the booking total to £194. Shall I add both?",quoted_additions:[proposal],fetched_at:1,_creationTime:1});
 };
 for(const text of ["How heavy is the Blackmagic 6K Full Frame camera?","Please add the Sony FX3 for £70 extra.","Please add the Blazar Remus 100mm only for £70 extra.","Please add two Blazar Remus 100mm and the PL to L mount for £70 extra.","Please add the Blazar Remus 100mm and PL to L mount for £60 extra.","Please add the Blazar Remus 100mm and PL to L mount for 22 to 23 October at £70 extra."]){
  it(`does not change the order for conflicting selection: ${text}`,async()=>{
   const f=setupAtomicAddition();f.tables.hygglo_messages[0].body_text=text;const before=structuredClone(f.tables);
   expect(await applyBasket(f.ctx)).toMatchObject({ok:false,action_performed:false,error_code:"addition_consent_unverified"});expect(f.tables).toEqual(before);
  });
 }
 it("blocks the same unrequested addition through the legacy single-item path",async()=>{
  const f=setupAtomicAddition();f.tables.hygglo_messages[0].body_text="How heavy is the camera?";const before=structuredClone(f.tables);
  expect(await applyCurrentChange(f.ctx,{thread_id:"__probe__atomic",action:"add_item",product_id:3,item_name:"PL to L mount",qty:1})).toMatchObject({ok:false,action_performed:false,error_code:"addition_consent_unverified"});expect(f.tables).toEqual(before);
 });
 it("accepts a natural reply to the actual exact Native offer once",async()=>{
  const f=setupAtomicAddition();await offer(f);f.tables.hygglo_messages.at(-1)!.body_text="Yes, please add both.";
  expect(await applyBasket(f.ctx)).toMatchObject({ok:true,action_performed:true,order:{total_gbp:194}});
  expect(await applyBasket(f.ctx)).toMatchObject({ok:true,already_applied:true,action_performed:false});expect(f.tables.renter_bot_lab_orders[0].changes).toHaveLength(1);
 });
 for(const variant of ["different_pool_same_name","component_quantity","missing_identity"]){
  it(`does not authorize changed physical equipment from an old addition quote: ${variant}`,async()=>{
   const f=setupAtomicAddition();await offer(f);f.tables.hygglo_messages.at(-1)!.body_text="Yes, please add both.";
   if(variant==="missing_identity")delete f.tables.hygglo_messages[0].quoted_additions[0].physical_identity_key;
   else {
    const component=f.tables.listing_resolution_override.find(r=>r.product_id===2).components[0];
    const item=f.tables.items.find(i=>i._id===component.item_id);item.qty=10;
    if(variant==="component_quantity")component.qty=2;
    else {f.tables.items.push({...item,_id:"replacement-pool"});component.item_id="replacement-pool";}
   }
   const fresh=await (quoteAdditionBasket as any)._handler(f.ctx,{thread_id:"__probe__atomic",items:[{product_id:2,qty:1},{product_id:3,qty:1}]});
   expect(fresh).toMatchObject({ok:true,quote:{total_gbp:194}});
   const before=structuredClone(f.tables);expect(await applyBasket(f.ctx)).toMatchObject({ok:false,action_performed:false,error_code:"addition_consent_unverified"});expect(f.tables).toEqual(before);
  });
 }
 for(const variant of ["changed_price","unused_quote","intervening_question"]){
  it(`does not reuse an offer after ${variant}`,async()=>{
   const f=setupAtomicAddition();await offer(f);f.tables.hygglo_messages.at(-1)!.body_text="Yes, please add both.";
   if(variant==="changed_price")f.tables.online_listings.find(i=>i.product_id===2).daily_price=30;
   if(variant==="unused_quote")f.tables.hygglo_messages[0].body_text="The camera weighs about one kilogram.";
   if(variant==="intervening_question")f.tables.hygglo_messages.splice(1,0,{thread_id:"__probe__atomic",message_id:"unrelated",sender:"renter",body_text:"How heavy is it?",fetched_at:1.5,_creationTime:1.5});
   const before=structuredClone(f.tables);expect(await applyBasket(f.ctx)).toMatchObject({ok:false,action_performed:false,error_code:"addition_consent_unverified"});expect(f.tables).toEqual(before);
  });
 }
});


describe("removals require the exact current renter request",()=>{
 const setup=()=>{const f=fixture();f.tables.renter_bot_lab_orders[0].items[0].product_id=1;f.tables.renter_bot_lab_orders[0].items[0].qty=3;return f;};
 for(const text of ["How heavy is the Sony FX3?","Please update my booking.","Please remove Sony A7 III.","Please remove two Sony FX3.","Please remove it.","If I remove Sony FX3, what would it cost?","Please remove Sony FX3 after I confirm.","Please remove Sony FX3 for £79.99 less."]){
  it(`rejects a conflicting removal after ${text}`,async()=>{const {tables,ctx}=setup();tables.hygglo_messages[0].body_text=text;const before=structuredClone(tables);
   expect(await remove(ctx,"Sony FX3",1)).toMatchObject({ok:false});expect(tables).toEqual(before);});
 }
 it("accepts the exact named units once and keeps current Native prices",async()=>{const {tables,ctx}=setup();tables.hygglo_messages[0].body_text="Please remove two Sony FX3.";
  expect(await remove(ctx,"Sony FX3",2)).toMatchObject({ok:true,action_performed:true,order:{total_gbp:80,lines:[expect.objectContaining({product_id:1,qty:1})]}});
  expect(await remove(ctx,"Sony FX3",2)).toMatchObject({ok:true,already_applied:true,action_performed:false});expect(tables.renter_bot_lab_orders[0].changes).toHaveLength(1);});
});


describe("consent uses Native offering components, never comparison titles",()=>{
 const setup=()=>{const f=fixture();f.tables.items[0].qty=3;f.tables.items[0].lens_mount="E";f.tables.renter_bot_lab_orders[0].items[0].product_id=1;
  f.tables.online_listings=[{account_slug:"leo",product_id:2,name:"Sony FX3 (same sensor as Sony A7S III)",daily_price:45}];
  f.tables.hygglo_product_index=[{account_slug:"leo",product_id:2,item_id:"camera"}];
  f.tables.listing_resolution_override=[{account_slug:"leo",product_id:1,components:[{item_id:"camera",qty:1}]},{account_slug:"leo",product_id:2,components:[{item_id:"camera",qty:1}]}];return f;};
 for(const path of ["atomic","legacy"]){
  it(`refuses a different model named in the title through ${path}`,async()=>{const {ctx,tables}=setup();tables.hygglo_messages[0].body_text="Please add Sony A7S III for £90 extra.";const before=structuredClone(tables);
   const result=path==="atomic" ? await (applyAdditionBasket as any)._handler(ctx,{thread_id:"__probe__atomic",request_message_id:"fixture-current",items:[{product_id:2,qty:1}]}) : await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"add_item",item_name:"Sony FX3",product_id:2,qty:1});
   expect(result).toMatchObject({ok:false,error_code:"addition_consent_unverified"});expect(tables).toEqual(before);});
 }
 it("accepts the real Native camera despite its advertising title",async()=>{const {ctx,tables}=setup();tables.hygglo_messages[0].body_text="Please add Sony FX3 for £90 extra.";
  expect(await (applyAdditionBasket as any)._handler(ctx,{thread_id:"__probe__atomic",request_message_id:"fixture-current",items:[{product_id:2,qty:1}]})).toMatchObject({ok:true,action_performed:true,order:{total_gbp:170}});});
 it("refuses a comparison-model removal and records the actual removed identity for retries",async()=>{const {ctx,tables}=setup();tables.renter_bot_lab_orders[0].items[0].name="Sony FX3 (same sensor as Sony A7S III)";
  tables.hygglo_messages[0].body_text="Please remove Sony A7S III.";let before=structuredClone(tables);
  expect(await applyCurrentChange(ctx,{thread_id:"__probe__atomic",action:"remove_item",item_name:"Sony FX3",product_id:1})).toMatchObject({ok:false,error_code:"removal_consent_unverified"});expect(tables).toEqual(before);
  tables.hygglo_messages[0].body_text="Please remove Sony FX3.";
  expect(await remove(ctx,"Sony FX3")).toMatchObject({ok:true,action_performed:true});before=structuredClone(tables);
  expect(await remove(ctx,"Sony FX3")).toMatchObject({ok:true,already_applied:true,action_performed:false});expect(tables).toEqual(before);
  expect(tables.renter_bot_lab_orders[0].changes[0].removed_item).toMatchObject({product_id:1,qty:1,identity_name:"Sony FX3"});
 });
});

describe("date quotes and positive consent",()=>{
 it("returns a complete read-only date quote without requiring an edit instruction",async()=>{
  const f=fixture();f.tables.hygglo_messages[0].body_text="What would one extra day cost?";const before=structuredClone(f.tables);
  const result=await applyCurrentChange(f.ctx,{thread_id:"__probe__atomic",action:"set_dates",start_date:"2026-10-06",end_date:"2026-10-08",preview_only:true});
  expect(result).toMatchObject({ok:true,preview_only:true,source:"native_lab_date_proposal",base_quote:{total_gbp:80},quote:{total_gbp:120},price_delta_gbp:40});
  expect(f.tables).toEqual(before);
 });
 for(const text of ["How heavy is the Sony FX3?","Please extend it.","Please extend the return to 8 October at £119.99 total.","Please extend the return to 9 October at £120 total."])
  it(`refuses to change dates after ${text}`,async()=>{
   const f=fixture();f.tables.hygglo_messages[0].body_text=text;const before=structuredClone(f.tables);
   expect(await extend(f.ctx)).toMatchObject({ok:false,error_code:"date_consent_unverified"});expect(f.tables).toEqual(before);
  });
 for(const variant of ["different_pool_same_name","missing_identity"]){
  it(`does not authorize changed physical equipment from an old date quote: ${variant}`,async()=>{
   const f=fixture();f.tables.renter_bot_lab_orders[0].items[0].product_id=1;
   f.tables.listing_resolution_override=[{account_slug:"leo",product_id:1,components:[{item_id:"camera",qty:1}]}];
   const quote=await applyCurrentChange(f.ctx,{thread_id:"__probe__atomic",action:"set_dates",start_date:"2026-10-06",end_date:"2026-10-08",preview_only:true});
   const proposal={physical_identity_key:quote.physical_identity_key,context_key:quote.before_context_key,from_start_date:"2026-10-06",from_end_date:"2026-10-07",start_date:"2026-10-06",end_date:"2026-10-08",total_gbp:120,base_total_gbp:80,epoch:86,quoted_for_message_id:"fixture-current",items:[{name:"Sony FX3",quantity:1}]};
   if(variant==="missing_identity")delete proposal.physical_identity_key;
   else {f.tables.items.push({...f.tables.items[0],_id:"replacement-pool"});f.tables.listing_resolution_override[0].components[0].item_id="replacement-pool";}
   f.tables.hygglo_messages.push({thread_id:"__probe__atomic",message_id:"owner",sender:"owner",body_text:"I can extend your booking to 6–8 October for £120 total.",fetched_at:2,quoted_dates:[proposal]}, {thread_id:"__probe__atomic",message_id:"accepted",sender:"renter",body_text:"Yes please extend it.",fetched_at:3});
   expect(await applyCurrentChange(f.ctx,{thread_id:"__probe__atomic",action:"set_dates",start_date:"2026-10-06",end_date:"2026-10-08",preview_only:true})).toMatchObject({ok:true,quote:{total_gbp:120}});
   const before=structuredClone(f.tables);expect(await extend(f.ctx)).toMatchObject({ok:false,error_code:"date_consent_unverified"});expect(f.tables).toEqual(before);
  });
 }
 it("accepts the exact saved offer and reruns stock before the write",async()=>{
  const f=fixture();const quote=await applyCurrentChange(f.ctx,{thread_id:"__probe__atomic",action:"set_dates",start_date:"2026-10-06",end_date:"2026-10-08",preview_only:true});
  f.tables.hygglo_messages.push({thread_id:"__probe__atomic",message_id:"owner",sender:"owner",body_text:"I can extend your booking to 6–8 October for £120 total.",fetched_at:2,quoted_dates:[{physical_identity_key:quote.physical_identity_key,context_key:quote.before_context_key,from_start_date:"2026-10-06",from_end_date:"2026-10-07",start_date:"2026-10-06",end_date:"2026-10-08",total_gbp:120,base_total_gbp:80,epoch:86,quoted_for_message_id:"fixture-current",items:[{name:"Sony FX3",quantity:1}]}]},
   {thread_id:"__probe__atomic",message_id:"accepted",sender:"renter",body_text:"Yes please extend it.",fetched_at:3});
  f.tables.owner_unavailability=[{item_id:"camera",start_date:"2026-10-08",end_date:"2026-10-08"}];const blocked=structuredClone(f.tables);
  expect(await extend(f.ctx)).toMatchObject({ok:false});expect(f.tables).toEqual(blocked);
  f.tables.owner_unavailability=[];expect(await extend(f.ctx)).toMatchObject({ok:true,action_performed:true,order:{total_gbp:120}});
  expect(await extend(f.ctx)).toMatchObject({ok:true,action_performed:false});
 });
});
