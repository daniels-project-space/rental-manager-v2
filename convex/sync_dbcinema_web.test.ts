import { describe, expect, it, vi, afterEach } from "vitest";
vi.mock("./hygglo", () => ({ computePollHash: (s: string) => s }));
vi.mock("./notifications", () => ({ queueNotificationEvents: vi.fn(async () => 1) }));
import { bookedUnitsOnDate } from "./lib/availability";
import { reservationItemUnits } from "./lib/reservations/itemUnits";
import { queueNotificationEvents } from "./notifications";
import { syncDbcinemaWeb, upsertSiteBookingsBatch } from "./sync_dbcinema_web";
const invoke = (f: any, ctx: any, args: any) => f._handler(ctx, args);
function database() {
 const rows = new Map<string, any>(); let serial=0;
 const db = {
  insert: async (table:string,value:any) => {const id=`${table}:${++serial}`;rows.set(id,{...value,_id:id,table});return id},
  patch: async (id:string,value:any) => { rows.set(id,{...rows.get(id),...value}) },
  query: (table:string) => {
   const equalities: Array<[string,any]>=[];
   const q:any={withIndex: (_:string, select:any) => {const selector:any={eq:(k:string,v:any)=>{equalities.push([k,v]);return selector}};select(selector);return q}, collect:async()=>[...rows.values()].filter(r=>r.table===table && equalities.every(([k,v])=>r[k]===v)),first:async()=>(await q.collect())[0]??null};return q;
  },
 };
 return {ctx:{db,scheduler:{runAfter:vi.fn()}},rows};
}
const booking=(extra:any={})=>({id:'web-rental-1',revision:1,status:'confirmed',customerName:'Alex',customerEmail:'test@example.invalid',fulfilment:'collection',pickupTime:'10:30',returnTime:'17:00',start:Date.UTC(2035,0,1),end:Date.UTC(2035,0,2),subtotal:100,discount:10,deliveryFee:0,depositAmount:20,total:110,currency:'GBP',createdAt:1,lineItems:[{title:'Camera',qty:1,units:[]}],...extra});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.clearAllMocks()});
describe('real website reservation sync handlers',()=>{
 it('emits one upcoming confirmation and preserves times, then ignores repeat and stale updates',async()=>{
  const {ctx,rows}=database();const b=booking();
  await invoke(upsertSiteBookingsBatch,ctx,{bookings:[b],reconcile:false});
  expect(queueNotificationEvents).toHaveBeenCalledTimes(1);
  expect(vi.mocked(queueNotificationEvents).mock.calls[0][1][0]).toMatchObject({thread_id:b.id,account_slug:'dbcinema_web',url:'https://dbcinemarentals.com/admin?rental=web-rental-1#messages'});
  const row=()=>[...rows.values()].find(r=>r.table==='reservations');expect(row()).toMatchObject({pickup_time:'10:30',return_time:'17:00',status:'confirmed'});
  expect(await invoke(upsertSiteBookingsBatch,ctx,{bookings:[b],reconcile:false})).toMatchObject({upserted:0,skipped:1});
  await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({revision:2,status:'returned',pickupTime:null,returnTime:null})],reconcile:false});
  expect(row()).toMatchObject({status:'completed',site_revision:2,order_step:'REVIEWED'});expect(row().pickup_time).toBeUndefined();
  await invoke(upsertSiteBookingsBatch,ctx,{bookings:[b],reconcile:false});expect(row().status).toBe('completed');expect(queueNotificationEvents).toHaveBeenCalledTimes(1);
 });
 it('imports history quietly and cancels only explicitly identified bookings',async()=>{
  const {ctx,rows}=database();await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({start:1,end:86400001}),booking({id:'other'})],reconcile:false});
  expect(queueNotificationEvents).toHaveBeenCalledTimes(1);
  await invoke(upsertSiteBookingsBatch,ctx,{bookings:[],reconcile:false});expect([...rows.values()].filter(r=>r.table==='reservations'&&r.status==='confirmed')).toHaveLength(2);
  await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({revision:2,status:'cancelled'})],reconcile:false});
  expect([...rows.values()].find(r=>r.hygglo_order_id==='web-rental-1')).toMatchObject({status:'cancelled',is_obsolete:true,order_step:undefined});expect([...rows.values()].find(r=>r.hygglo_order_id==='other').status).toBe('confirmed');
 });
 it('clears obsolete image hints instead of retaining unrelated equipment photos',async()=>{
  const {ctx,rows}=database();await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking()],reconcile:false});const row=[...rows.values()].find(r=>r.table==='reservations');await ctx.db.patch(row._id,{image_hints:[{url:'wrong'}],photos_urls:['wrong'],order_step:'DELIVERED'});
  await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({revision:2})],reconcile:false});expect(rows.get(row._id)).toMatchObject({image_hints:[],photos_urls:[],order_step:undefined});
 });
 it('uses the saved physical stock ledger and each item date rather than current listing decomposition',async()=>{
  const {ctx,rows}=database();const id=await ctx.db.insert('items',{name_canonical:'Sony FX3',image_url:'https://example.invalid/fx3.png'});
  const day=(n:number)=>Date.UTC(2035,0,n);
  const physicalReservations=[{rmv2ItemId:id,hyggloProductId:42,qty:3,start:day(1),end:day(2)},{rmv2ItemId:id,hyggloProductId:42,qty:3,start:day(4),end:day(5)}];
  await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({end:day(5),physicalReservations})],reconcile:false});
  const row=[...rows.values()].find(r=>r.table==='reservations');expect(row.expanded_items).toEqual([{item_id:id,item_name_canonical:'Sony FX3',qty:3}]);
  expect(row.site_item_windows).toHaveLength(2);expect(row.photos_urls).toEqual(['https://example.invalid/fx3.png']);expect(row.hygglo_items[0]).toMatchObject({qty:3,product_id:42});
  expect(bookedUnitsOnDate([row] as any,id as any,'2035-01-01')).toBe(3);expect(bookedUnitsOnDate([row] as any,id as any,'2035-01-03')).toBe(0);expect(bookedUnitsOnDate([row] as any,id as any,'2035-01-04')).toBe(3);
  expect(reservationItemUnits(row,new Map()).get(id)).toBe(3);
  expect(bookedUnitsOnDate([row] as any,id as any,'2035-01-03',{productIndex:new Map(),overrides:new Map(),inventory:[]})).toBe(0);
  await expect(invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({revision:2,physicalReservations:[{...physicalReservations[0],rmv2ItemId:'missing'}]})],reconcile:false})).rejects.toThrow('canonical master inventory mapping');
  await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({revision:3,physicalReservations:[]})],reconcile:false});expect(reservationItemUnits([...rows.values()].find(r=>r.table==='reservations'),new Map()).size).toBe(0);
 });
 it('fetches beyond 1000 rentals without reconciling partial pages',async()=>{
  vi.stubEnv('DBCINEMA_CONVEX_URL','https://store.example.invalid');vi.stubEnv('DBCINEMA_ADMIN_TOKEN','fixture');let page=0;
  vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{const req=JSON.parse(options.body);expect(req.path).toBe('rmv2_sync:forRmv2SyncPage');expect(req.args.paginationOpts.cursor).toBe(page?String(page):null);page++;return {ok:true,json:async()=>({status:'success',value:{authorized:true,bookings:Array.from({length:100},(_,i)=>booking({id:`${page}-${i}`})),isDone:page===12,continueCursor:String(page)}})}}));
  const ctx={runMutation:vi.fn(async(_ref,args)=>{expect(args.reconcile).toBe(false);return {upserted:args.bookings.length,mapped_units:0,unmapped_units:0}})};
  expect(await invoke(syncDbcinemaWeb,ctx,{})).toMatchObject({ok:true,upserted:1200});expect(ctx.runMutation).toHaveBeenCalledTimes(12);
 });
 it('stops on a stalled cursor without any absence cancellation',async()=>{
  vi.stubEnv('DBCINEMA_CONVEX_URL','https://store.example.invalid');vi.stubEnv('DBCINEMA_ADMIN_TOKEN','fixture');vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({status:'success',value:{authorized:true,bookings:[],isDone:false,continueCursor:'same'}})})));
  const ctx={runMutation:vi.fn(async(_ref,args)=>{expect(args.reconcile).toBe(false);return {upserted:0,mapped_units:0,unmapped_units:0}})};expect(await invoke(syncDbcinemaWeb,ctx,{})).toMatchObject({ok:false,reason:'invalid_cursor'});expect(ctx.runMutation).toHaveBeenCalledTimes(2);
 });
});

it('persists individual equipment clocks and refuses malformed times before changing saved stock',async()=>{
 const {ctx,rows}=database();const id=await ctx.db.insert('items',{name_canonical:'Sony FX3'});const start=Date.UTC(2035,0,1),end=Date.UTC(2035,0,2);
 const windows=[{rmv2ItemId:id,qty:1,start,end,pickupTime:'10:00',returnTime:'12:00'},{rmv2ItemId:id,qty:1,start:start+3*86400000,end:end+3*86400000,pickupTime:null,returnTime:null}];
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({physicalReservations:windows})],reconcile:false});
 const saved=[...rows.values()].find(r=>r.table==='reservations');expect(saved.site_item_windows.map((w:any)=>[w.pickupTime,w.returnTime])).toEqual([['10:00','12:00'],[null,null]]);
 const previous=JSON.stringify(saved.site_item_windows);
 for(const returnTime of ['25:00','9am','12:99'])await expect(invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({revision:2,physicalReservations:[{...windows[0],returnTime}]})],reconcile:false})).rejects.toThrow('Invalid website equipment time');
 expect(JSON.stringify(rows.get(saved._id).site_item_windows)).toBe(previous);
});
