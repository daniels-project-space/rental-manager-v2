import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("./auth",()=>({authComponent:{safeGetAuthUser:async()=>null}}));
import {getOutOfStockItems} from "./items";
import {computeFast} from "./mv/widgets";
import {custodyRenterKey,custodyUnitsKey} from "./lib/reservation_custody";
const item={_id:"lens",_creationTime:1,name_canonical:"Sony FE 24-70mm f/2.8 GM",qty:2,status:"active",kind:"lens"};
const proof=(date:string,time:string)=>({source:"agreed_chat",date,time,confirmedAt:1});
const booking=(id:string,extra:any={})=>({_id:id,_creationTime:1,hygglo_order_id:id,account_slug:"leo",renter_name:id,status:"confirmed",order_step:"DELIVERED",start_date:"2026-10-09",end_date:"2026-10-09",resolved_items:[{item_id:"lens",qty:1,item_name_canonical:item.name_canonical}],...extra});
function context(rows:any[],extra:Record<string,any[]>={}){
 const tables:Record<string,any[]>={reservations:rows,items:[item],...extra};const reads:any[]=[];
 const ctx={db:{query:(table:string)=>{
  let data=[...(tables[table]??[])];const ix:any={};
  for(const op of ["eq","gt","gte","lt","lte"])ix[op]=(k:string,v:any)=>{data=data.filter(r=>op==="eq"?r[k]===v:op==="gt"?r[k]>v:op==="gte"?r[k]>=v:op==="lt"?r[k]<v:r[k]<=v);return ix;};
  const q:any={withIndex:(index:string,fn?:any)=>{reads.push([table,index]);fn?.(ix);return q;},order:()=>q,collect:async()=>data,first:async()=>data[0]??null,take:async(n:number)=>data.slice(0,n)};return q;
 }}} as any;
 return {ctx,reads};
}
const query=(ctx:any,accountSlug:string|null=null)=> (getOutOfStockItems as any)._handler(ctx,{accountSlug,lookAheadDays:14});
beforeEach(()=>{vi.stubEnv("OWNER_AUTH_REQUIRED","false");vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe("actual optional stock forecast query and producer",()=>{
 it("does not add disjoint hires over fourteen days to manufacture unavailable stock",async()=>{
  const rows=[booking("first"),booking("second",{start_date:"2026-10-11",end_date:"2026-10-11"})];
  expect(await query(context(rows).ctx)).toEqual([]);
 });
 it("counts a canonical two-unit booking and returns the confirmed buffered London boundary",async()=>{
  const r=booking("kit",{hygglo_items:[{name:"Two lenses",product_id:42,qty:1}],return_time:"17:00",return_time_provenance:proof("2026-10-09","17:00")});
  const rows=await query(context([r],{listing_resolution_override:[{account_slug:"leo",product_id:42,components:[{item_id:"lens",qty:2}]}]}).ctx);
  expect(rows[0]).toMatchObject({activeReservationCount:2,currentlyUnavailable:true,nextAvailableAt:Date.parse("2026-10-09T17:00:00Z"),nextAvailableDate:"2026-10-09"});
 });
 it("shows a future booked period distinctly from stock unavailable now",async()=>{
  const r=booking("future",{start_date:"2026-10-11",end_date:"2026-10-11",resolved_items:[{item_id:"lens",qty:2}],pickup_time:"15:00",pickup_time_provenance:proof("2026-10-11","15:00")});
  expect((await query(context([r]).ctx))[0]).toMatchObject({currentlyUnavailable:false,blockedFromAt:Date.parse("2026-10-11T14:00:00Z"),activeReservationCount:2});
 });
 it("keeps an unconfirmed return occupied through the next day's one-hour buffer",async()=>{
  const r=booking("uncertain",{resolved_items:[{item_id:"lens",qty:2}],return_time:"17:00"});
  expect((await query(context([r]).ctx))[0].nextAvailableAt).toBe(Date.parse("2026-10-10T00:00:00Z"));
 });
 it("uses physical stock across account views and includes paid website commitments",async()=>{
  const r=booking("paid-web",{account_slug:"dbcinema_web",status:"pending_review",order_step:"VERIFIED",site_item_windows:[{item_id:"lens",start:Date.parse("2026-10-09T09:00Z"),end:Date.parse("2026-10-09T17:00Z"),qty:2,endExclusive:true,stockWindowVersion:2,turnaroundBufferMinutes:60}]});
  const f=context([r]);expect((await query(f.ctx,"leo"))[0].activeReservationCount).toBe(2);
 });
 it("does not collapse independent rentals merely because the renter name matches",async()=>{
  const rows=[booking("one",{renter_name:"Same"}),booking("two",{renter_name:"Same"})];
  expect((await query(context(rows).ctx))[0].activeReservationCount).toBe(2);
  const linked=rows.map(r=>({...r,stock_custody_group_id:"one",stock_custody_provenance:{source:"owner_confirmation",account_slug:r.account_slug,order_id:r.hygglo_order_id,renter_key:custodyRenterKey(r),units_key:custodyUnitsKey(new Map([["lens",1]])),start_date:r.start_date,end_date:r.end_date,confirmed_at:1,confirmed_by:"owner",note:"The customer retained the same lens throughout this extension."}}));
  expect(await query(context(linked).ctx)).toEqual([]);
 });
 it("rejects old unversioned caches and recalculates real stock",async()=>{
  const f=context([],{mv_widgets:[{key:"oos:all",generatedAt:Date.now(),payload:[{itemId:"ghost",activeReservationCount:999}]}]});
  expect(await query(f.ctx)).toEqual([]);
 });
 it("uses the actual producer snapshot on the fast path and advances at the return without rescanning bookings",async()=>{
  const r=booking("return",{resolved_items:[{item_id:"lens",qty:2}],return_time:"17:00",return_time_provenance:proof("2026-10-09","17:00")});
  const produced=await (computeFast as any)._handler(context([r]).ctx,{});
  const f=context([],{mv_widgets:[{key:"oos:leo",generatedAt:Date.now(),payload:produced.oos.leo}]});
  expect((await query(f.ctx,"leo"))[0].activeReservationCount).toBe(2);
  vi.setSystemTime(new Date("2026-10-09T17:00:00Z"));
  // Timestamp kept fresh to isolate the clock projection from the age gate.
  const after=context([],{mv_widgets:[{key:"oos:leo",generatedAt:Date.now(),payload:produced.oos.leo}]});
  expect(await query(after.ctx,"leo")).toEqual([]);
  expect(f.reads.some(([table]:string[])=>table==="reservations")).toBe(false);
 });
 it("keeps current repair holds shared and does not invent a repair completion time",async()=>{
  const f=context([],{insurance_claims:[{account_slug:"dbcinema",stage:"in_for_repair",repair_item_ids:["lens","lens"]}]});
  expect((await query(f.ctx,"leo"))[0]).toMatchObject({currentlyUnavailable:true,inRepair:2,nextAvailableAt:null});
 });
});
