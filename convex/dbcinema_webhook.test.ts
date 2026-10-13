import { describe, expect, it, vi, afterEach } from 'vitest';
import {getFunctionName} from 'convex/server';
vi.mock('./auth',()=>({authComponent:{registerRoutes:vi.fn()},createAuth:vi.fn()}));
vi.mock('./hygglo',()=>({computePollHash:(s:string)=>s}));
vi.mock('./notifications',()=>({queueNotificationEvents:vi.fn(async()=>1)}));
import pipeline from './fixtures/dbcinema_paid_stock.json';
import {loadStockSources,stockForItem} from './lib/renter_stock';
import http from './http';
import { upsertSiteBookingsBatch } from './sync_dbcinema_web';
const route=http.lookup('/dbcinema/booking-sync','POST')![0] as any;
function fixture(){
 const rows=new Map<string,any>();let serial=0;
 const db={insert:async(table:string,value:any)=>{const id=`${table}:${++serial}`;rows.set(id,{...value,_id:id,table});return id},patch:async(id:string,value:any)=>rows.set(id,{...rows.get(id),...value}),query:(table:string)=>{
  const equalities:Array<[string,any]>=[];const q:any={withIndex:(_:string,select:any)=>{const selector:any={eq:(k:string,v:any)=>{equalities.push([k,v]);return selector}};select(selector);return q},collect:async()=>[...rows.values()].filter(r=>r.table===table&&equalities.every(([k,v])=>r[k]===v)),first:async()=>(await q.collect())[0]??null};return q;
 }};
 const ctx:any={db,scheduler:{runAfter:vi.fn()}};ctx.runMutation=vi.fn(async(_ref,args)=>{expect(args.reconcile).toBe(false);return(upsertSiteBookingsBatch as any)._handler(ctx,args)});return{ctx,rows};
}
const booking=(extra:any={})=>({id:'web-receipt',revision:4,status:'confirmed',start:Date.UTC(2035,0,1),end:Date.UTC(2035,0,2),subtotal:100,total:100,currency:'GBP',lineItems:[],...extra});
const request=(b:any,token='receipt-fixture')=>new Request('https://manager.example.invalid/dbcinema/booking-sync',{method:'POST',headers:{'content-type':'application/json','x-dbcinema-sync-token':token},body:JSON.stringify({booking:b})});
const invoke=(ctx:any,req:Request)=>route._handler(ctx,req) as Promise<Response>;
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks()});
describe('actual booking-sync HTTP receipts',()=>{
 it('attests exact application, repeat, newer return and stale delivery',async()=>{
  vi.stubEnv('DBCINEMA_WEBHOOK_SECRET','receipt-fixture');const{ctx,rows}=fixture(),b=booking();
  expect(await(await invoke(ctx,request(b))).json()).toEqual({ok:true,version:1,bookingId:b.id,receivedRevision:4,appliedRevision:4,outcome:'applied'});
  expect(await(await invoke(ctx,request(b))).json()).toMatchObject({outcome:'unchanged',appliedRevision:4});
  expect(await(await invoke(ctx,request(booking({revision:5,status:'returned'})))).json()).toMatchObject({outcome:'applied',receivedRevision:5,appliedRevision:5});
  expect([...rows.values()].find(r=>r.table==='reservations')).toMatchObject({site_revision:5,status:'completed',order_step:'REVIEWED'});
  expect(await(await invoke(ctx,request(b))).json()).toMatchObject({outcome:'stale',receivedRevision:4,appliedRevision:5});
  expect([...rows.values()].find(r=>r.table==='reservations')).toMatchObject({site_revision:5,status:'completed'});
 });
 it('attests only the explicit unpaid skip and refuses unknown records',async()=>{
  vi.stubEnv('DBCINEMA_WEBHOOK_SECRET','receipt-fixture');const{ctx,rows}=fixture();
  expect(await(await invoke(ctx,request(booking({status:'pending_payment'})))).json()).toEqual({ok:true,version:1,bookingId:'web-receipt',receivedRevision:4,appliedRevision:null,outcome:'ignored',reason:'unpaid'});
  expect([...rows.values()].some(r=>r.table==='reservations')).toBe(false);expect((await invoke(ctx,request(booking({status:'unknown'})))).status).toBe(422);
 });
 it('rejects auth, config and malformed requests before mutation',async()=>{
  const{ctx}=fixture();vi.stubEnv('DBCINEMA_WEBHOOK_SECRET','receipt-fixture');expect((await invoke(ctx,request(booking(),'foreign'))).status).toBe(401);
  vi.stubEnv('DBCINEMA_WEBHOOK_SECRET','');expect((await invoke(ctx,request(booking()))).status).toBe(503);
  vi.stubEnv('DBCINEMA_WEBHOOK_SECRET','receipt-fixture');expect((await invoke(ctx,request(null))).status).toBe(400);expect(ctx.runMutation).not.toHaveBeenCalled();
 });
 it('never issues success when real upsert rejects physical evidence',async()=>{
  vi.stubEnv('DBCINEMA_WEBHOOK_SECRET','receipt-fixture');const{ctx}=fixture();const response=await invoke(ctx,request(booking({physicalReservations:[{rmv2ItemId:'missing-master',qty:1,start:1,end:86400001}]})));
  expect(response.status).toBe(500);expect(await response.json()).toMatchObject({ok:false});
 });
});

it('accepts verification only through the secret bridge and applies a new revision without a booking-status transition',async()=>{
 vi.stubEnv('DBCINEMA_WEBHOOK_SECRET','receipt-fixture');const{ctx,rows}=fixture();
 const verification={version:1,provider:'didit',status:'processing',checks:{identity:'approved',selfie:'approved',address:'review'},accountId:'account-bound',sessionId:'source-session',updatedAt:1000,securityReady:true,archiveReady:false,requiresDroneLicence:false,droneLicenceStatus:'not_required',approved:false};
 const pending=booking({verification});expect((await invoke(ctx,request(pending,'foreign'))).status).toBe(401);expect(ctx.runMutation).not.toHaveBeenCalled();
 expect(await(await invoke(ctx,request(pending))).json()).toMatchObject({outcome:'applied',appliedRevision:4});
 const approved=booking({revision:5,verification:{...verification,status:'verified',archiveReady:true,approved:true}});
 expect(await(await invoke(ctx,request(approved))).json()).toMatchObject({outcome:'applied',appliedRevision:5});
 expect([...rows.values()].find(r=>r.table==='reservations')).toMatchObject({status:'confirmed',site_verification:{approved:true,sessionId:'source-session'}});
 expect((await invoke(ctx,request(booking({revision:5,verification})))).status).toBe(500);
 expect([...rows.values()].find(r=>r.table==='reservations').site_verification.approved).toBe(true);
});

describe('actual website producer -> authenticated receiver -> native stock inquiry',()=>{
 it('uses exact paid physical allocation before verification, excludes cash from income, ignores repeats/stale events and releases returned gear',async()=>{
  vi.stubEnv('DBCINEMA_WEBHOOK_SECRET','receipt-fixture');const{ctx,rows}=fixture();
  const itemId=await ctx.db.insert('items',{name_canonical:'Sony FX3',qty:1,status:'active',is_marketing_only:false});expect(itemId).toBe('items:1');
  const lookup=async()=>stockForItem(await loadStockSources(ctx),rows.get(itemId),{item_name:'Sony FX3',start_date:'2035-01-01',end_date:'2035-01-01',pickup_time:'10:00',return_time:'11:00'} as any);
  expect((await lookup()).free_units).toBe(1);
  expect(await(await invoke(ctx,request(pipeline.unpaid))).json()).toMatchObject({outcome:'ignored',reason:'unpaid'});expect((await lookup()).free_units).toBe(1);
  expect((await invoke(ctx,request(pipeline.paid,'wrong-token'))).status).toBe(401);expect((await lookup()).free_units).toBe(1);
  expect(await(await invoke(ctx,request(pipeline.paid))).json()).toMatchObject({outcome:'applied',appliedRevision:1});
  const row=()=>[...rows.values()].find(r=>r.table==='reservations');expect(row()).toMatchObject({status:'pending_review',net_to_owner_gbp:20,gross_paid_gbp:20});expect(row().site_item_windows[0]).toMatchObject({item_id:itemId,start:Date.UTC(2035,0,1,10),end:Date.UTC(2035,0,2,18),qty:1});expect((await lookup()).free_units).toBe(0);expect(ctx.scheduler.runAfter.mock.calls.some((call:any[])=>call[2]?.force===true&&getFunctionName(call[1])==='mv/reply_queue:refresh' )).toBe(true);
  expect(await(await invoke(ctx,request(pipeline.paid))).json()).toMatchObject({outcome:'unchanged'});expect((await lookup()).free_units).toBe(0);
  expect(await(await invoke(ctx,request(pipeline.returned))).json()).toMatchObject({outcome:'applied',appliedRevision:2});expect((await lookup()).free_units).toBe(1);
  expect(await(await invoke(ctx,request(pipeline.paid))).json()).toMatchObject({outcome:'stale',appliedRevision:2});expect((await lookup()).free_units).toBe(1);
 });
});
