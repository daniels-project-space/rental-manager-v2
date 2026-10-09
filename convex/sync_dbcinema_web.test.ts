import { describe, expect, it, vi, afterEach } from "vitest";
vi.mock("./hygglo", () => ({ computePollHash: (s: string) => s }));
vi.mock("./notifications", () => ({ queueNotificationEvents: vi.fn(async () => 1) }));
import { loadStockSources, stockForItem } from "./lib/renter_stock";
import { realisedMonthRevenue } from "./lib/reservations/monthRevenue";
import { isPendingVerification, isUpcoming } from "./lib/reservations/predicates";
import { computePollHash } from "./hygglo";
import { bookedUnitsOnDate, repairHeldUnits } from "./lib/availability";
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
const booking=(extra:any={})=>({id:'web-rental-1',revision:1,status:'confirmed',verification:verification({status:'verified',archiveReady:true,approved:true}),customerName:'Alex',customerEmail:'test@example.invalid',fulfilment:'collection',pickupTime:'10:30',returnTime:'17:00',start:Date.UTC(2035,0,1),end:Date.UTC(2035,0,2),subtotal:100,discount:10,deliveryFee:0,depositAmount:20,total:110,currency:'GBP',createdAt:1,lineItems:[{title:'Camera',qty:1,units:[]}],...extra});
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
  await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({revision:2})],reconcile:false});expect(rows.get(row._id)).toMatchObject({image_hints:[],photos_urls:[],order_step:'BOOKED_AFTER_VERIFIED'});
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

it('imports source damage cases exactly once and preserves assessed payouts across website revisions',async()=>{
 vi.stubEnv('OWNER_AUTH_REQUIRED','true');
 const {ctx,rows}=database();const c={id:'source-case-1',itemKey:'unit:0',title:'Sony FX3 · unit 1',details:'Damaged casing with photographs',status:'open',openedAt:2000,closedAt:null,resolution:null,customerAccountId:'web-customer',rmv2ItemId:null as string | null};
 const itemId=await ctx.db.insert('items',{name_canonical:'Sony FX3'});c.rmv2ItemId=itemId;
 const b=booking({status:'returned',damageCases:[c]});await invoke(upsertSiteBookingsBatch,ctx,{bookings:[b],reconcile:false});
 const claim=()=>[...rows.values()].find(r=>r.table==='insurance_claims');expect(claim()).toMatchObject({site_case_id:c.id,site_booking_id:b.id,site_customer_account_id:'web-customer',description:c.details,item_name_canonical:c.title,amount_gbp:0,status:'open',stage:'case_opened'});
 expect(claim().repair_item_ids).toEqual([itemId]);expect(repairHeldUnits([claim()] as any,itemId as any)).toBe(0);
 const reservation=[...rows.values()].find(r=>r.table==='reservations');expect(claim().reservation_id).toBe(reservation._id);expect(reservation.net_to_owner_gbp).toBe(90);
 await ctx.db.patch(claim()._id,{amount_gbp:250,stage:'quote_received',payout_amount_gbp:150,description:'Operator added repair quotation.'});
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[b],reconcile:false});expect([...rows.values()].filter(r=>r.table==='insurance_claims')).toHaveLength(1);expect(repairHeldUnits([claim()] as any,itemId as any)).toBe(1);
 const closed={...c,status:'closed',closedAt:3000,resolution:'Repair complete and case resolved.'};await invoke(upsertSiteBookingsBatch,ctx,{bookings:[{...b,revision:2,damageCases:[closed]}],reconcile:false});expect(claim()).toMatchObject({site_case_status:'closed',site_case_resolution:closed.resolution,stage:'quote_received',amount_gbp:250,payout_amount_gbp:150,description:'Operator added repair quotation.'});
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[b],reconcile:false});expect(claim().site_case_status).toBe('closed');
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[{...b,revision:3}],reconcile:false});expect(claim().site_case_status).toBe('closed');
});
it('rejects duplicate or misbound cases rather than moving evidence to another rental',async()=>{
 vi.stubEnv('OWNER_AUTH_REQUIRED','true');
 const {ctx}=database();const c={id:'source-case',itemKey:'legacy:0',title:'Lens',details:'Scratched coating',status:'open',openedAt:2000,closedAt:null,resolution:null,customerAccountId:null,rmv2ItemId:null};
 await expect(invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({damageCases:[c,c]})],reconcile:false})).rejects.toThrow('Invalid website damage cases');
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({damageCases:[c]})],reconcile:false});
 await expect(invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({id:'other-booking',damageCases:[c]})],reconcile:false})).rejects.toThrow('binding mismatch');
});

it('blocks private case import until public manager queries enforce owner access',async()=>{
 vi.stubEnv('OWNER_AUTH_REQUIRED','false');const {ctx,rows}=database();const c={id:'private-case',itemKey:'unit:0',title:'Camera',details:'Private customer evidence',status:'open',openedAt:2000,closedAt:null,resolution:null,customerAccountId:'private-account',rmv2ItemId:null};
 await expect(invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({damageCases:[c]})],reconcile:false})).rejects.toThrow('enforced owner authentication');expect([...rows.values()].filter(r=>r.table==='insurance_claims')).toHaveLength(0);
});

const verification=(extra:any={})=>({version:1,provider:"didit",status:"processing",checks:{identity:"approved",selfie:"approved",address:"review"},accountId:"customer-1",sessionId:"source-case-session",updatedAt:1000,securityReady:true,archiveReady:false,requiresDroneLicence:false,droneLicenceStatus:"not_required",approved:false,...extra});
it('persists verification independently of paid status, refuses conflicting or stale approvals, and keeps financial and stock totals unchanged',async()=>{
 const {ctx,rows}=database();
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({verification:verification()})],reconcile:false});
 const saved=()=>[...rows.values()].find(r=>r.table==='reservations');
 expect(saved().site_verification).toMatchObject({approved:false,sessionId:'source-case-session'});
 const before={net:saved().net_to_owner_gbp,gross:saved().gross_paid_gbp,stock:saved().expanded_items};
 const approved=verification({status:'verified',approved:true,archiveReady:true});
 await expect(invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({verification:approved})],reconcile:false})).rejects.toThrow('Conflicting website rental revision');
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({revision:2,verification:approved})],reconcile:false});
 expect(saved()).toMatchObject({site_revision:2,status:'confirmed',order_step:'BOOKED_AFTER_VERIFIED',site_verification:approved});
 expect({net:saved().net_to_owner_gbp,gross:saved().gross_paid_gbp,stock:saved().expanded_items}).toEqual(before);
 expect(await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({revision:2,verification:approved})],reconcile:false})).toMatchObject({upserted:0,skipped:1});
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({verification:verification()})],reconcile:false});expect(saved().site_verification.approved).toBe(true);
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({revision:3,verification:verification({status:'rejected'})})],reconcile:false});
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({revision:2,verification:approved})],reconcile:false});expect(saved().site_verification.approved).toBe(false);
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({revision:4,verification:undefined})],reconcile:false});expect(saved().site_verification).toBeUndefined();
});
it('rejects malformed or inconsistent approvals before writes and permits authenticated human review override',async()=>{
 const {ctx,rows}=database();
 for(const verificationValue of [verification({version:2}),verification({checks:{identity:'bogus',selfie:'approved',address:'approved'}}),verification({status:'verified',approved:true,archiveReady:true,accountId:null}),verification({status:'verified',approved:true,archiveReady:false}),verification({status:'verified',approved:true,archiveReady:true,requiresDroneLicence:true,droneLicenceStatus:'waiting'})]){
  await expect(invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({verification:verificationValue})],reconcile:false})).rejects.toThrow(/website verification/);
 }
 expect([...rows.values()].filter(r=>r.table==='reservations')).toHaveLength(0);
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({verification:verification({status:'verified',approved:true,archiveReady:true,sessionId:null})})],reconcile:false});
 expect([...rows.values()].find(r=>r.table==='reservations').site_verification).toMatchObject({approved:true,checks:{address:'review'},sessionId:null});
});

it('retains the v2 buffered endpoint marker through the real website receiver',async()=>{
 const {ctx,rows}=database();const id=await ctx.db.insert('items',{name_canonical:'Sony FX3'});
 const physicalReservations=[{rmv2ItemId:id,qty:1,start:Date.UTC(2035,0,1,10),end:Date.UTC(2035,0,2,18),pickupTime:'10:00',returnTime:'17:00',endExclusive:true,stockWindowVersion:2,turnaroundBufferMinutes:60}];
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({physicalReservations})],reconcile:false});
 expect([...rows.values()].find(r=>r.table==='reservations').site_item_windows[0]).toMatchObject({end:Date.UTC(2035,0,2,18),returnTime:'17:00',turnaroundBufferMinutes:60});
 await expect(invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({revision:2,physicalReservations:[{...physicalReservations[0],turnaroundBufferMinutes:120}]})],reconcile:false})).rejects.toThrow('Invalid website turnaround buffer');
});

it('retains signed civil dates without changing exact stock epochs and rejects impossible dates',async()=>{const {ctx,rows}=database();const id=await ctx.db.insert('items',{name_canonical:'Sony FX3'});const w={rmv2ItemId:id,qty:1,start:Date.UTC(2026,9,8,23),end:Date.UTC(2026,9,11,0),endExclusive:true,stockWindowVersion:2,turnaroundBufferMinutes:60,pickupDate:'2026-10-09',returnDate:'2026-10-10',returnTime:'18:00'};await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({physicalReservations:[w]})],reconcile:false});const saved=[...rows.values()].find(r=>r.table==='reservations');expect(saved.site_item_windows[0]).toMatchObject({start:w.start,end:w.end,pickupDate:w.pickupDate,returnDate:w.returnDate,item_id:id});for(const returnDate of ['2026-02-30','2026-10-08','10/10/2026'])await expect(invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({revision:2,physicalReservations:[{...w,returnDate}]})],reconcile:false})).rejects.toThrow('Invalid website equipment date');});


it('keeps paid unverified website rentals pending, occupies stock and excludes confirmed revenue until documents approve', async () => {
 const {ctx,rows}=database();
 const itemId=await ctx.db.insert('items',{name_canonical:'Sony FX3',qty:2,status:'active',is_marketing_only:false});
 const physicalReservations=[{rmv2ItemId:itemId,qty:1,start:Date.UTC(2035,0,1,10),end:Date.UTC(2035,0,2,18),endExclusive:true,stockWindowVersion:2,turnaroundBufferMinutes:60,pickupTime:'10:00',returnTime:'17:00'}];
 const pending=booking({physicalReservations,verification:verification()});
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[pending],reconcile:false});
 const row=()=>[...rows.values()].find(r=>r.table==='reservations');
 expect(row()).toMatchObject({status:'pending_review',order_step:'VERIFIED',site_projection_version:2});
 expect(isPendingVerification(row())).toBe(true);expect(isUpcoming(row(),'2034-12-31')).toBe(false);
 expect(realisedMonthRevenue([row()],'2035-01','dbcinema_web').netGbp).toBe(0);
 expect(queueNotificationEvents).not.toHaveBeenCalled();
 const sources=await loadStockSources(ctx as any);
 expect(stockForItem(sources,rows.get(itemId),{item_name:'Sony FX3',start_date:'2035-01-01',end_date:'2035-01-01',pickup_time:'10:00',return_time:'11:00'} as any).free_units).toBe(1);
 const docs=verification({status:'verified',archiveReady:true,documentsApproved:true,securityReady:false,approved:false});
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[{...pending,revision:2,verification:docs}],reconcile:false});
 expect(row()).toMatchObject({status:'confirmed',order_step:'BOOKED_AFTER_VERIFIED',site_verification:{documentsApproved:true,securityReady:false,approved:false}});
 expect(realisedMonthRevenue([row()],'2035-01','dbcinema_web').netGbp).toBe(90);
 expect(queueNotificationEvents).toHaveBeenCalledTimes(1);expect(row().site_item_windows).toHaveLength(1);
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[{...pending,revision:3,verification:verification({status:'requires_input'})}],reconcile:false});
 expect(row()).toMatchObject({status:'pending_review',order_step:'VERIFIED'});
 expect(realisedMonthRevenue([row()],'2035-01','dbcinema_web').netGbp).toBe(0);
 expect(row().gross_paid_gbp).toBe(90);expect(row().site_item_windows).toHaveLength(1);
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[{...pending,revision:2,verification:docs}],reconcile:false});expect(row().status).toBe('pending_review');
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[{...pending,revision:4,status:'cancelled'}],reconcile:false});
 expect((await loadStockSources(ctx as any)).reservations).toHaveLength(0);
});

it('fails closed on a missing verification snapshot and rejects inconsistent document approvals',async()=>{
 const {ctx,rows}=database();await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({verification:undefined})],reconcile:false});
 expect([...rows.values()].find(r=>r.table==='reservations')).toMatchObject({status:'pending_review',order_step:'VERIFIED'});
 for(const snapshot of [verification({documentsApproved:true}),verification({status:'verified',archiveReady:true,documentsApproved:false,approved:true}),verification({documentsApproved:'yes'})])
  await expect(invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({revision:2,verification:snapshot})],reconcile:false})).rejects.toThrow(/website document approval/);
});

it('upgrades only an exact unchanged legacy projection at the same source revision',async()=>{
 const {ctx,rows}=database();const b=booking({verification:verification()});await invoke(upsertSiteBookingsBatch,ctx,{bookings:[b],reconcile:false});
 const saved=[...rows.values()].find(r=>r.table==='reservations');
 const oldFields=JSON.parse(saved.poll_hash);delete oldFields.site_projection_version;oldFields.status='confirmed';delete oldFields.order_step;
 await ctx.db.patch(saved._id,{site_projection_version:undefined,status:'confirmed',order_step:undefined,poll_hash:computePollHash(JSON.stringify(oldFields))});
 await expect(invoke(upsertSiteBookingsBatch,ctx,{bookings:[{...b,total:999}],reconcile:false})).rejects.toThrow('Conflicting website rental revision');
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[b],reconcile:false});
 expect(rows.get(saved._id)).toMatchObject({status:'pending_review',site_projection_version:2,site_revision:1});
 await expect(invoke(upsertSiteBookingsBatch,ctx,{bookings:[{...b,verification:verification({status:'verified',archiveReady:true,approved:true})}],reconcile:false})).rejects.toThrow('Conflicting website rental revision');
});


it('upgrades the documents-only approval projection without changing source revision or bypassing the conflict fence',async()=>{
 const {ctx,rows}=database();const old=verification({status:'verified',archiveReady:true,securityReady:false,approved:false});const b=booking({verification:old});
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[b],reconcile:false});const row=()=>[...rows.values()].find(r=>r.table==='reservations');expect(row()).toMatchObject({status:'pending_review',site_projection_version:2});
 const current={...b,verification:{...old,documentsApproved:true}};
 await expect(invoke(upsertSiteBookingsBatch,ctx,{bookings:[{...current,total:999}],reconcile:false})).rejects.toThrow('Conflicting website rental revision');
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[current],reconcile:false});expect(row()).toMatchObject({status:'confirmed',site_projection_version:3,site_revision:1});
 await expect(invoke(upsertSiteBookingsBatch,ctx,{bookings:[{...current,verification:{...current.verification,documentsApproved:false}}],reconcile:false})).rejects.toThrow('Conflicting website rental revision');
});


it('imports legacy not-required cancellation history without granting verification or collection approval',async()=>{
 const {ctx,rows}=database();const legacy=verification({status:'not_required'});
 await invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({id:'legacy-cancelled',status:'cancelled',verification:legacy}),booking({id:'legacy-paid',verification:legacy})],reconcile:false});
 const cancelled=[...rows.values()].find(r=>r.hygglo_order_id==='legacy-cancelled');const paid=[...rows.values()].find(r=>r.hygglo_order_id==='legacy-paid');
 expect(cancelled).toMatchObject({status:'cancelled',is_obsolete:true,site_verification:{status:'not_required',approved:false}});
 expect(paid).toMatchObject({status:'pending_review',order_step:'VERIFIED'});expect(realisedMonthRevenue([paid],'2035-01','dbcinema_web').netGbp).toBe(0);expect(queueNotificationEvents).not.toHaveBeenCalled();
 for(const flag of ['approved','documentsApproved'])await expect(invoke(upsertSiteBookingsBatch,ctx,{bookings:[booking({revision:2,verification:{...legacy,archiveReady:true,[flag]:true}})],reconcile:false})).rejects.toThrow(/Inconsistent website/);
});
