import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("./auth",()=>({authComponent:{safeGetAuthUser:async()=>null}}));
import {getStatsDrawerData} from "./dashboard";
import {custodyRenterKey,custodyUnitsKey} from "./lib/reservation_custody";
const item={_id:"lens",_creationTime:1,name_canonical:"Sony FE 24-70mm f/2.8 GM",qty:1,status:"active",kind:"lens"};
const proof=(date:string,time:string)=>({source:"agreed_chat",date,time,confirmedAt:1});
function rental(id:string,extra:any={}){return {_id:id,_creationTime:1,hygglo_order_id:id,account_slug:"leo",renter_name:id,status:"confirmed",order_step:"DELIVERED",start_date:"2026-10-09",end_date:"2026-10-09",resolved_items:[{item_id:"lens",qty:1,confidence:1}],...extra};}
function context(rows:any[],extra:Record<string,any[]>={}){
 const tables:Record<string,any[]>={reservations:rows,items:[item],...extra};
 return {db:{get:async()=>null,query:(table:string)=>{
  let data=[...(tables[table]??[])];const ix:any={};
  for(const op of ["eq","gt","gte","lt","lte"])ix[op]=(k:string,v:any)=>{data=data.filter(r=>op==="eq"?r[k]===v:op==="gt"?r[k]>v:op==="gte"?r[k]>=v:op==="lt"?r[k]<v:r[k]<=v);return ix;};
  const q:any={withIndex:(_:string,fn:any)=>{fn(ix);return q;},order:()=>q,filter:()=>q,collect:async()=>data,first:async()=>data[0]??null,take:async(n:number)=>data.slice(0,n)};return q;
 }}} as any;
}
const stats=(ctx:any)=> (getStatsDrawerData as any)._handler(ctx,{accountSlug:null,_bypassMv:true});
beforeEach(()=>{vi.stubEnv("OWNER_AUTH_REQUIRED","false");vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe("actual dashboard conflicts share checkout stock windows",()=>{
 it("blocks the full turnaround hour, then allows a confirmed evening handover",async()=>{
  const first=rental("first",{return_time:"17:00",return_time_provenance:proof("2026-10-09","17:00")});
  const second=rental("second",{pickup_time:"17:30",pickup_time_provenance:proof("2026-10-09","17:30")});
  expect((await stats(context([first,second]))).conflicts[0]).toMatchObject({overlap_count:2,severity:"confirmed"});
  second.pickup_time="18:00";second.pickup_time_provenance=proof("2026-10-09","18:00");
  expect((await stats(context([first,second]))).conflicts).toEqual([]);
 });
 it("does not release at an unaccepted proposed return clock",async()=>{
  const rows=[rental("first",{return_time:"17:00"}),rental("second",{pickup_time:"20:00",pickup_time_provenance:proof("2026-10-09","20:00")})];
  expect((await stats(context(rows))).conflicts[0].overlap_count).toBe(2);
 });
 it("does not extend expired booked periods through an overdue custody flag",async()=>{
  const rows=[rental("expired",{start_date:"2026-10-08",end_date:"2026-10-08",return_time:"17:00",return_time_provenance:proof("2026-10-08","17:00")}),rental("current")];
  expect((await stats(context(rows))).conflicts).toEqual([]);
 });
 it("uses canonical bundled quantities rather than the single product-index body",async()=>{
  const r=rental("kit",{hygglo_items:[{name:"Two GM lenses",product_id:42,qty:1}],resolved_items:[]});
  const result=await stats(context([r],{hygglo_product_index:[{account_slug:"leo",product_id:42,item_id:"lens"}],listing_resolution_override:[{account_slug:"leo",product_id:42,components:[{item_id:"lens",qty:2}]}]}));
  expect(result.conflicts[0].overlap_count).toBe(2);
 });
 it("preserves an unknown return's overnight buffer after the prior calendar day",async()=>{
  const rows=[rental("unknown",{start_date:"2026-10-08",end_date:"2026-10-08"}),rental("midnight")];
  expect((await stats(context(rows))).conflicts[0]).toMatchObject({overlap_count:2,conflict_start:"2026-10-09"});
 });
 it("warns separately about a pending request rather than reporting a confirmed oversell",async()=>{
  const result=await stats(context([rental("confirmed"),rental("request",{status:"pending_review",order_step:"VERIFIED"})]));
  expect(result.conflicts[0]).toMatchObject({overlap_count:2,severity:"pending"});
 });
 it("honours partial website item windows and keeps a single booking action",async()=>{
  const start=Date.parse("2026-10-09T08:00:00Z"),end=Date.parse("2026-10-09T16:00:00Z");
  const web=rental("web",{account_slug:"dbcinema_web",site_item_windows:[{item_id:"lens",start,end,qty:2,endExclusive:true,stockWindowVersion:2,turnaroundBufferMinutes:60}]});
  const result=await stats(context([web]));
  expect(result.conflicts[0].overlap_count).toBe(2);expect(result.conflicts[0].reservations).toHaveLength(1);
 });
 it("keeps only evidenced shared custody collapsed and preserves independent orders",async()=>{
  const linked=[rental("original",{renter_name:"Same renter"}),rental("extension",{renter_name:"Same renter"})].map(r=>({...r,stock_custody_group_id:"original",stock_custody_provenance:{source:"owner_confirmation",account_slug:r.account_slug,order_id:r.hygglo_order_id,renter_key:custodyRenterKey(r),units_key:custodyUnitsKey(new Map([["lens",1]])),start_date:r.start_date,end_date:r.end_date,confirmed_at:1,confirmed_by:"owner",note:"Owner confirms that the same kit remained with this customer."}}));
  const independent=rental("separate",{renter_name:"Same renter"});
  const ctx=context([...linked,independent],{items:[{...item,qty:2}]});
  expect((await stats(ctx)).conflicts).toEqual([]);
  linked[1].return_time="17:00";linked[1].end_date="2026-10-10";
  expect((await stats(context([...linked,independent],{items:[{...item,qty:2}]}))).conflicts[0].overlap_count).toBe(3);
 });
 it("compares elapsed instants correctly within London's repeated autumn clock",async()=>{
  vi.setSystemTime(new Date("2026-10-25T12:00:00Z"));
  const window=(start:string,end:string)=>({item_id:"lens",start:Date.parse(start),end:Date.parse(end),qty:1,endExclusive:true,stockWindowVersion:2,turnaroundBufferMinutes:60});
  const first=rental("first",{account_slug:"dbcinema_web",start_date:"2026-10-25",end_date:"2026-10-25",site_item_windows:[window("2026-10-25T00:00:00Z","2026-10-25T01:00:00Z")]});
  const second=rental("second",{account_slug:"dbcinema_web",start_date:"2026-10-25",end_date:"2026-10-25",site_item_windows:[window("2026-10-25T00:30:00Z","2026-10-25T02:00:00Z")]});
  expect((await stats(context([first,second]))).conflicts[0].overlap_count).toBe(2);
 });
 it("rejects cached conflicts computed with the old clock rules",async()=>{
  const result=await (getStatsDrawerData as any)._handler(context([],{mv_stats_drawer:[{account:"all",payload:{stockConflictVersion:1,conflicts:[{conflict_key:"obsolete"}]}}]}),{accountSlug:null});
  expect(result.stockConflictVersion).toBe(2);expect(result.conflicts).toEqual([]);
 });
});
