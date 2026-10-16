import { describe, expect, it, vi } from "vitest";
import { pruneSubscriptions, savePushSubscription, removePushSubscription, renewPushSubscription } from "./notifications";

// Exercise the real registered mutation handlers with an in-memory database
// adapter; transport and browser permission are verified separately.
function database() {
  const rows = new Map<string, any>();
  let serial = 0;
  const db = {
    insert: async (table: string, value: any) => { const id = `${table}:${++serial}`; rows.set(id, { ...value, _id: id, table }); return id; },
    patch: async (id: string, value: any) => { rows.set(id, { ...rows.get(id), ...value }); },
    delete: async (id: string) => { rows.delete(id); },
    query: (table: string) => {
      let equality: [string, any] | undefined;
      const result: any = {
        withIndex: (_name: string, select: any) => { select({ eq: (key: string, value: any) => { equality = [key, value]; } }); return result; },
        collect: async () => [...rows.values()].filter(r => r.table === table && (!equality || r[equality[0]] === equality[1])),
        first: async () => (await result.collect())[0] ?? null,
        unique: async () => { const found = await result.collect(); if (found.length > 1) throw Error("not unique"); return found[0] ?? null; },
      };
      return result;
    },
  };
  return { ctx: { db, scheduler: { runAfter: vi.fn() } }, rows };
}
const keys = { p256dh: btoa(String.fromCharCode(4) + "k".repeat(64)), auth: btoa("a".repeat(16)) };
const phone = "https://web.push.apple.com/phone";
const desktop = "https://fcm.googleapis.com/desktop";
const invoke = (registered: any, ctx: any, args: any) => registered._handler(ctx, args);
describe("actual push registration mutations", () => {
  it("keeps the selected phone through repeated desktop refreshes", async () => {
    const { ctx, rows } = database();
    await invoke(savePushSubscription, ctx, { endpoint: phone, ...keys, activate: true, mode: "all" });
    for (let n = 0; n < 5; n++) expect(await invoke(savePushSubscription, ctx, { endpoint: desktop, ...keys })).toMatchObject({ active: false, status: "inactive" });
    expect([...rows.values()].filter(r => r.table === "push_subscriptions").map(r => r.endpoint)).toEqual([phone]);
  });
  it("retains ownership and mode after a 410 prune, then accepts only its renewal", async () => {
    const { ctx, rows } = database();
    await invoke(savePushSubscription, ctx, { endpoint: phone, ...keys, activate: true, mode: "my_share" });
    await invoke(pruneSubscriptions, ctx, { endpoints: [phone] });
    expect([...rows.values()].filter(r => r.table === "push_subscriptions")).toHaveLength(0);
    expect(await invoke(savePushSubscription, ctx, { endpoint: desktop, ...keys })).toMatchObject({ active: false });
    expect(await invoke(savePushSubscription, ctx, { endpoint: phone, ...keys })).toMatchObject({ status: "renewal_required", active: false });
    expect(await invoke(savePushSubscription, ctx, { endpoint: `${phone}-new`, previous_endpoint: phone, ...keys })).toMatchObject({ active: true, mode: "my_share" });
    expect([...rows.values()].find(r => r.table === "push_registration")).toMatchObject({ endpoint: `${phone}-new`, needs_renewal: false });
  });
  it("migrates the existing destination without letting a new heartbeat claim it", async () => {
    const { ctx, rows } = database();
    await ctx.db.insert("push_subscriptions", { endpoint: phone, ...keys, mode: "money_only", last_seen_at: 1, created_at: 1 });
    expect(await invoke(savePushSubscription, ctx, { endpoint: desktop, ...keys })).toMatchObject({ active: false });
    expect(await invoke(savePushSubscription, ctx, { endpoint: phone, ...keys })).toMatchObject({ active: true, mode: "money_only" });
    expect([...rows.values()].find(r => r.table === "push_registration").endpoint).toBe(phone);
  });
  it("allows explicit transfer while preserving the one-destination rule", async () => {
    const { ctx, rows } = database();
    await invoke(savePushSubscription, ctx, { endpoint: desktop, ...keys, activate: true, mode: "my_share" });
    await invoke(savePushSubscription, ctx, { endpoint: phone, ...keys, activate: true, mode: "all" });
    expect([...rows.values()].filter(r => r.table === "push_subscriptions").map(r => r.endpoint)).toEqual([phone]);
    expect(await invoke(savePushSubscription, ctx, { endpoint: desktop, ...keys })).toMatchObject({ active: false });
  });
  it("does not infer activation from a stale client's mode-bearing refresh", async () => {
    const { ctx, rows } = database();
    await invoke(savePushSubscription, ctx, { endpoint: phone, ...keys, activate: true, mode: "my_share" });
    expect(await invoke(savePushSubscription, ctx, { endpoint: desktop, ...keys, mode: "all" })).toMatchObject({ active: false, status: "inactive" });
    expect([...rows.values()].find(r => r.table === "push_registration")).toMatchObject({ endpoint: phone, mode: "my_share" });
  });
  it("does not silently re-enable after an explicit removal", async () => {
    const { ctx } = database();
    await invoke(savePushSubscription, ctx, { endpoint: phone, ...keys, activate: true });
    await invoke(removePushSubscription, ctx, { endpoint: phone });
    expect(await invoke(savePushSubscription, ctx, { endpoint: phone, previous_endpoint: phone, ...keys })).toMatchObject({ active: false });
  });
});

const token="a".repeat(64),otherToken="b".repeat(64);
describe("selected phone renewal capability",()=>{
 const setup=async()=>{const f=database();await invoke(savePushSubscription,f.ctx,{endpoint:phone,...keys,activate:true,mode:"my_share",renewal_credential:token,user_agent:"iPhone"});return f;};
 it("stores only the capability hash and renews without an owner login",async()=>{
  const f=await setup();const registration=[...f.rows.values()].find(r=>r.table==="push_registration");
  expect(registration.renewal_credential_hash).toMatch(/^[a-f0-9]{64}$/);expect(registration.renewal_credential_hash).not.toBe(token);
  expect(await invoke(renewPushSubscription,f.ctx,{endpoint:phone+"-new",previous_endpoint:phone,...keys,renewal_credential:token})).toMatchObject({active:true,mode:"my_share"});
  const sub=[...f.rows.values()].find(r=>r.table==="push_subscriptions");expect(sub.user_agent).toBe("iPhone");
 });
 for(const invalid of ["",otherToken,"phone endpoint is not a credential"]){
  it(`refuses an invalid capability (${invalid.length} characters) without writes`,async()=>{
   const f=await setup(),before=structuredClone([...f.rows]);
   expect(await invoke(renewPushSubscription,f.ctx,{endpoint:desktop,previous_endpoint:phone,...keys,renewal_credential:invalid})).toMatchObject({active:false});expect([...f.rows]).toEqual(before);
  });
 }
 it("refuses a wrong previous destination even with a valid capability",async()=>{
  const f=await setup(),before=structuredClone([...f.rows]);expect(await invoke(renewPushSubscription,f.ctx,{endpoint:desktop,previous_endpoint:desktop,...keys,renewal_credential:token})).toMatchObject({active:false});expect([...f.rows]).toEqual(before);
 });
 it("keeps the token and mode through repeated endpoint rotations",async()=>{
  const f=await setup();let endpoint=phone;
  for(let i=0;i<3;i++){const next=phone+i;expect(await invoke(renewPushSubscription,f.ctx,{endpoint:next,previous_endpoint:endpoint,...keys,renewal_credential:token})).toMatchObject({active:true,mode:"my_share"});endpoint=next;}
  expect([...f.rows.values()].filter(r=>r.table==="push_subscriptions")).toHaveLength(1);
 });
 it("accepts changed keys on a pruned but unchanged endpoint URL",async()=>{
  const f=await setup();await invoke(pruneSubscriptions,f.ctx,{endpoints:[phone]});
  expect(await invoke(renewPushSubscription,f.ctx,{endpoint:phone,previous_endpoint:phone,...keys,renewal_credential:token})).toMatchObject({active:false,status:"renewal_required"});
  expect(await invoke(renewPushSubscription,f.ctx,{endpoint:phone,previous_endpoint:phone,...keys,auth:btoa("b".repeat(16)),renewal_credential:token})).toMatchObject({active:true,mode:"my_share"});
 });
 it("does not treat base64 encoding changes as fresh encryption keys",async()=>{
  const f=await setup();await invoke(pruneSubscriptions,f.ctx,{endpoints:[phone]});
  expect(await invoke(renewPushSubscription,f.ctx,{endpoint:phone,previous_endpoint:phone,p256dh:keys.p256dh.replace(/=+$/,""),auth:keys.auth.replace(/=+$/,""),renewal_credential:token})).toMatchObject({active:false,status:"renewal_required"});
 });
 it("revokes the old capability when delivery moves to another device",async()=>{
  const f=await setup();await invoke(savePushSubscription,f.ctx,{endpoint:desktop,...keys,activate:true,renewal_credential:otherToken});const before=structuredClone([...f.rows]);
  expect(await invoke(renewPushSubscription,f.ctx,{endpoint:phone,previous_endpoint:desktop,...keys,renewal_credential:token})).toMatchObject({active:false});expect([...f.rows]).toEqual(before);
 });
 it("revokes on disable and does not revive the old credential on re-enable",async()=>{
  const f=await setup();await invoke(removePushSubscription,f.ctx,{endpoint:phone});expect(await invoke(renewPushSubscription,f.ctx,{endpoint:phone,previous_endpoint:phone,...keys,renewal_credential:token})).toMatchObject({active:false});
  await invoke(savePushSubscription,f.ctx,{endpoint:phone,...keys,activate:true,renewal_credential:otherToken});expect(await invoke(renewPushSubscription,f.ctx,{endpoint:phone,previous_endpoint:phone,...keys,renewal_credential:token})).toMatchObject({active:false});
 });
});

import { claimPending, listRecent, queueNotificationEvents } from "./notifications";
import { rentalReminderEvent } from "./lib/rental_timing_notifications";

describe("real timing event queue, bell and delivery claims",()=>{
 const now=Date.parse("2035-07-01T11:45Z");
 const rental:any={_id:"rental",hygglo_order_id:"fixture",account_slug:"diogo",renter_name:"Alex",status:"confirmed",order_step:"DELIVERED",start_date:"2035-07-01",end_date:"2035-07-01",pickup_time:"13:00",return_time:"13:00",items:[{item_name:"Camera",qty:1}]};
 function fixture(){
  const rows:any[]=[{...rental,table:"reservations"}];const writes:any[]=[];
  const db:any={get:async(id:string)=>rows.find(r=>r._id===id),patch:async(id:string,fields:any)=>{Object.assign(rows.find(r=>r._id===id),fields);writes.push({id,fields})},insert:async(table:string,fields:any)=>{const id=table+rows.length;rows.push({_id:id,...fields,table});return id},query:(table:string)=>{
   const filters:Array<(r:any)=>boolean>=[];let desc=false;
   const select:any={eq:(k:string,v:any)=>{filters.push(r=>r[k]===v);return select}};
   const matches=()=>rows.filter(r=>r.table===table&&filters.every(f=>f(r))).sort((a,b)=>(desc?-1:1)*((a.created_at??0)-(b.created_at??0)));
   const q:any={withIndex:(_n:string,f?:any)=>{f?.(select);return q},order:(dir:string)=>{desc=dir==="desc";return q},take:async(n:number)=>matches().slice(0,n),first:async()=>matches()[0]??null};return q;
  }};
  return {ctx:{db,scheduler:{runAfter:vi.fn()}},rows,writes};
 }
 it("queues all three logistics types once and includes them in All, while income lanes stay income-only",async()=>{
  vi.spyOn(Date,"now").mockReturnValue(now);
  try{
   const f=fixture();const events=[rentalReminderEvent(rental,now,"pickup")!,rentalReminderEvent(rental,now,"return")!,{type:"rental_time_changed" as const,event_key:"schedule-fixture",thread_id:"fixture",account_slug:"diogo",title:"Alex has changed their rental times",body:"Pickup: 14:00 → 15:00",url:"/?thread=fixture"}];
   expect(await queueNotificationEvents(f.ctx as any,events)).toBe(3);expect(await queueNotificationEvents(f.ctx as any,events)).toBe(0);
   const all=await invoke(listRecent,f.ctx,{mode:"all"});expect(all.events.map((e:any)=>e.type).sort()).toEqual(["pickup_reminder","rental_time_changed","return_reminder"]);
   for(const mode of ["my_share","money_only"])expect((await invoke(listRecent,f.ctx,{mode})).events).toEqual([]);
   expect(f.writes).toEqual([]); // No reservation writes, nor any real transport.
  }finally{vi.restoreAllMocks()}
 });
 it("refreshes both reminder countdowns on a delayed claim and drops cancelled, rescheduled and expired claims",async()=>{
  vi.spyOn(Date,"now").mockReturnValue(now);
  try{
   for(const kind of ["pickup","return"] as const){
    const f=fixture(),event=rentalReminderEvent(rental,now,kind)!;await queueNotificationEvents(f.ctx as any,[event]);
    vi.mocked(Date.now).mockReturnValue(now+2*60_000);
    expect((await invoke(claimPending,f.ctx,{}))[0].title).toBe(`You have a ${kind} in 13 minutes`);
    for(const patch of [{status:"cancelled"},{pickup_time:"14:00",return_time:"14:00"},{}]){
     const g=fixture();await queueNotificationEvents(g.ctx as any,[event]);Object.assign(g.rows[0],patch);
     if(Object.keys(patch).length===0)vi.mocked(Date.now).mockReturnValue(now+15*60_000);
     expect(await invoke(claimPending,g.ctx,{})).toEqual([]);expect(g.writes.every(w=>w.id!=="rental")).toBe(true);
    }
    vi.mocked(Date.now).mockReturnValue(now);
   }
  }finally{vi.restoreAllMocks()}
 });
});
