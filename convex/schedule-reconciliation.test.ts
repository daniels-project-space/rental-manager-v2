import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("./auth",()=>({authComponent:{safeGetAuthUser:async()=>null}}));
import { reconcileReservationTimeProvenance } from "./extract_booking_times_q";
import { propagateGroupedTimesCron } from "./reservations";
import { confirmedClock } from "./lib/confirmed_schedule";
import { stockOccupancyForItem } from "./lib/renter_stock";

function fixture(rows:any[]){
 const docs=new Map(rows.map(r=>[r._id,structuredClone(r)])),threads=new Map<string,any[]>(),audits:any[]=[],jobs:any[]=[],reads:any[]=[];
 const ctx:any={db:{get:async(id:string)=>structuredClone(docs.get(id)??null),patch:async(id:string,p:any)=>Object.assign(docs.get(id),p),insert:async(table:string,p:any)=>{if(table==='audit_log')audits.push(p);else docs.set('cursor',{_id:'cursor',...p});return table;},query:(table:string)=>{
  const filters:any[]=[];let thread='';const q:any={withIndex:(index:string,fn:any)=>{reads.push([table,index]);const ix:any={eq:(key:string,value:any)=>{filters.push([key,value,'eq']);if(key==='thread_id')thread=value;return ix;},gte:(key:string,value:any)=>{filters.push([key,value,'gte']);return ix;}};fn(ix);return q;},order:()=>q,first:async()=>structuredClone(docs.get('cursor')??null),take:async(n:number)=>(threads.get(thread)??[]).slice(-n).reverse(),paginate:async({numItems,cursor}:any)=>{
   const selected=[...docs.values()].filter(r=>r._id!=='cursor'&&filters.every(([k,v,op])=>op==='eq'?r[k]===v:r[k]>=v)).sort((a,b)=>a._id.localeCompare(b._id));const offset=Number(cursor??0),page=selected.slice(offset,offset+numItems);return {page,isDone:offset+numItems>=selected.length,continueCursor:String(offset+numItems)};
  }};return q;
 }},scheduler:{runAfter:async(...args:any[])=>jobs.push(args)}};
 return {ctx,docs,threads,audits,jobs,reads};
}
const row=(id:string,extra:any={})=>({_id:id,hygglo_order_id:id,renter_id:'same-person',account_slug:'leo',status:'confirmed',start_date:'2026-10-09',end_date:'2026-10-09',times_extracted_at:10,times_transcript_hash:'model-watermark',...extra});
const agreed=(time:string)=>[{sender:'renter',body_text:`Return at ${time}`,hygglo_sent_at:100},{sender:'owner',body_text:'Yes!',hygglo_sent_at:200}];
afterEach(()=>vi.useRealTimers());
describe('actual handover evidence backstop',()=>{
 it('recovers from the own thread without borrowing an overlapping order clock or suppressing model extraction',async()=>{
  const f=fixture([row('early',{return_time:'17:00'}),row('later',{return_time:'17:00'})]);f.threads.set('early',agreed('5pm'));f.threads.set('later',agreed('7pm'));
  await reconcileReservationTimeProvenance(f.ctx,'early' as any);await reconcileReservationTimeProvenance(f.ctx,'later' as any);
  expect(confirmedClock(f.docs.get('early'),'return','2026-10-09')).toBe('17:00');expect(confirmedClock(f.docs.get('later'),'return','2026-10-09')).toBe('19:00');
  for(const r of f.docs.values()){expect(r.times_extracted_at).toBe(10);expect(r.times_transcript_hash).toBe('model-watermark');}
  const audits=f.audits.length;expect(await reconcileReservationTimeProvenance(f.ctx,'later' as any)).toMatchObject({changed:false});expect(f.audits).toHaveLength(audits);
 });
 it('invalidates a newly unaccepted return and keeps the whole day plus one-hour buffer occupied',async()=>{
  const f=fixture([row('uncertain',{return_time:'17:00',return_time_provenance:{source:'agreed_chat',date:'2026-10-09',time:'17:00',confirmedAt:200}})]);
  f.threads.set('uncertain',[...agreed('5pm'),{sender:'renter',body_text:'Can I return in the evening instead?',hygglo_sent_at:300}]);
  await reconcileReservationTimeProvenance(f.ctx,'uncertain' as any);const rental=f.docs.get('uncertain');expect(confirmedClock(rental,'return','2026-10-09')).toBeUndefined();
  const item:any={_id:'camera'};const source:any={reservations:[rental],reservationUnits:new Map([['uncertain',new Map([['camera',1]])]])};
  const occupied=stockOccupancyForItem(source,item,{item_name:'Camera',start_date:'2026-10-09',end_date:'2026-10-10'});expect(occupied[0].end).toBe('2026-10-10T01:00');
 });
 it('leaves signed website periods and obsolete bookings untouched',async()=>{
  const web=row('website',{account_slug:'dbcinema_web',pickup_time:'09:00',return_time:'21:00',site_item_windows:[]}),old=row('old',{is_obsolete:true});const f=fixture([web,old]);f.threads.set('website',agreed('5pm'));
  expect(await reconcileReservationTimeProvenance(f.ctx,'website' as any)).toBeNull();expect(await reconcileReservationTimeProvenance(f.ctx,'old' as any)).toBeNull();expect(f.docs.get('website')).toEqual(web);expect(f.audits).toEqual([]);
 });
 it('does not replace a newer confirmed provider handover with an older chat agreement',async()=>{
  const f=fixture([row('provider',{return_time:'19:00',return_time_provenance:{source:'provider_booking',date:'2026-10-09',time:'19:00',confirmedAt:500}})]);f.threads.set('provider',agreed('5pm'));
  expect(await reconcileReservationTimeProvenance(f.ctx,'provider' as any)).toMatchObject({changed:false});expect(confirmedClock(f.docs.get('provider'),'return','2026-10-09')).toBe('19:00');
 });
 it('preserves the newer evidence even when an older conversation has the same clock',async()=>{
  const f=fixture([row('same-clock',{return_time:'17:00',return_time_provenance:{source:'provider_booking',date:'2026-10-09',time:'17:00',confirmedAt:500}})]);f.threads.set('same-clock',agreed('5pm'));
  expect(await reconcileReservationTimeProvenance(f.ctx,'same-clock' as any)).toMatchObject({changed:false});expect(f.docs.get('same-clock').return_time_provenance.source).toBe('provider_booking');expect(f.docs.get('same-clock').return_time_provenance.confirmedAt).toBe(500);
 });
 it('pages both committed statuses, freezes the cursor cutoff across midnight and queues no no-op rebuild',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-09T23:50:00Z'));
  const f=fixture([...Array.from({length:52},(_,i)=>row(`confirmed-${String(i).padStart(3,'0')}`)),row('active',{status:'ongoing'}),row('ancient',{end_date:'2026-10-01'})]);
  const first=await(propagateGroupedTimesCron as any)._handler(f.ctx,{});expect(first).toMatchObject({checked:50,patched:0,hasMore:true,status:'confirmed'});expect(f.docs.get('cursor').cutoff).toBe('2026-10-08');
  vi.setSystemTime(new Date('2026-10-10T00:05:00Z'));const second=await(propagateGroupedTimesCron as any)._handler(f.ctx,{});expect(second.checked).toBe(2);expect(f.docs.get('cursor').status).toBe('ongoing');expect(f.docs.get('cursor').cursor).toBeNull();
  const third=await(propagateGroupedTimesCron as any)._handler(f.ctx,{});expect(third.checked).toBe(1);expect(f.docs.get('cursor').status).toBe('confirmed');expect(f.jobs).toEqual([]);
  expect(f.reads.filter(([table]:string[])=>table==='reservations').every(([,index]:string[])=>index==='by_status_end_date')).toBe(true);
 });
 it('schedules one genuine calendar refresh after accepted time recovery',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));const f=fixture([row('accepted')]);f.threads.set('accepted',agreed('5pm'));
  expect(await(propagateGroupedTimesCron as any)._handler(f.ctx,{})).toMatchObject({patched:1});expect(f.jobs).toHaveLength(1);expect(f.jobs[0][2]).toEqual({force:true});
 });
});
