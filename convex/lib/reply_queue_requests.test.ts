import { describe, expect, it } from "vitest";
import type { QueryCtx } from "../_generated/server";
import { loadReplyQueueRequestRows } from "./reply_queue_requests";
import { useReservationReadModel } from "./reservation_read_queries";
import { reservationReadMetadata } from "./reservation_read_model";
import { packCacheValue, cacheByteDigest } from "./lossless_cache_codec";
const cutoff=20;
const row=(id:string,time:number,extra:any={})=>({_id:id,_creationTime:time,account_slug:"leo",status:"confirmed",order_step:"REQUEST",created_at:1,full:{float:1.0000000000000002,array:[null,"complete"]},...extra});
const indexes:Record<string,string[]>={by_order_step_created_at:["order_step","created_at","_creationTime"],by_awaiting_owner_action_created_at:["awaiting_owner_action","created_at","_creationTime"],by_order_step:["order_step","_creationTime"],by_awaiting_owner_action:["awaiting_owner_action","_creationTime"],by_source_creation_time:["source_creation_time"],by_key:["key"]};
function compare(a:any,b:any){return a===b?0:a===undefined?-1:b===undefined?1:a<b?-1:1;}
async function fixture(rows:any[],packed:boolean){
 const records=await Promise.all(rows.map(async(r,i)=>{const data=packCacheValue(r);return {_id:`cache${i}`,_creationTime:1000-i,source_id:r._id,source_creation_time:r._creationTime,version:1,valid:true,data,packed_sha256:await cacheByteDigest(data),...reservationReadMetadata(r)};}));
 const tables:Record<string,any[]>={reservations:rows,reservation_read_records:records,reservation_read_gate:[{_id:"gate",_creationTime:1,key:"full:v1",version:1,enabled:true,ready:true}]};
 const reads:{table:string,index:string,fields:string[],ids:string[]}[]=[];
 const db={query(table:string){let index="",fields:string[]=[],filters:((r:any)=>boolean)[]=[];const q={withIndex(name:string,build?:(q:any)=>unknown){index=name;let previous=-1;const range={eq(k:string,v:any){const position=fields.indexOf(k);expect(position).toBeGreaterThan(previous);previous=position;filters.push(r=>r[k]===v);return range;},gte(k:string,v:any){expect(fields).toContain(k);filters.push(r=>r[k]!==undefined&&r[k]>=v);return range;}};fields=(indexes[name]??[]).map(k=>table==="reservation_read_records"&&k==="_creationTime"?"source_creation_time":k);build?.(range);return q;},async collect(){const values=(tables[table]??[]).filter(r=>filters.every(f=>f(r))).sort((a,b)=>{for(const k of fields){const c=compare(a[k],b[k]);if(c)return c;}return compare(a._id,b._id);});reads.push({table,index,fields,ids:values.map(r=>r.source_id??r._id)});return structuredClone(values);},async take(n:number){return (await q.collect()).slice(0,n);},async unique(){const r=await q.collect();if(r.length>1)throw Error("duplicate");return r[0]??null;}};return q;}};
 const ctx={db}as unknown as QueryCtx;if(packed)useReservationReadModel(ctx);return {ctx,reads};
}
function previous(rows:any[]){
 const sort=(xs:any[],field:string)=>xs.sort((a,b)=>compare(a[field],b[field])||compare(a._creationTime,b._creationTime)||compare(a._id,b._id));
 const recent=sort(rows.filter(r=>r._creationTime>=cutoff),"_creationTime");
 const unique=(rs:any[])=>[...new Map(rs.map(r=>[r._id,r])).values()];
 return {byStep:unique([...sort(rows.filter(r=>r.order_step==="REQUEST"&&r.created_at>=cutoff),"created_at"),...recent.filter(r=>r.order_step==="REQUEST")]),byAction:unique([...sort(rows.filter(r=>r.awaiting_owner_action===true&&r.created_at>=cutoff),"created_at"),...recent.filter(r=>r.awaiting_owner_action===true)])};
}
const cases:[string,any[]][]=[
 ["empty",[]],
 ["late imports",[row("a",20),row("b",21,{order_step:"ACCEPTED",awaiting_owner_action:true})]],
 ["inclusive source clock",[row("a",1,{created_at:20}),row("b",2,{created_at:19.999})]],
 ["inclusive insertion clock",[row("a",20),row("b",19.999)]],
 ["missing source timestamp",[row("a",21,{created_at:undefined})]],
 ["both request indicators",[row("a",21,{created_at:21,awaiting_owner_action:true})]],
 ["undefined booleans and nonrequest steps",[row("a",21,{order_step:undefined}),row("b",22,{order_step:"RETURNED",awaiting_owner_action:false})]],
 ["accounts and full fields",[row("a",21,{account_slug:undefined}),row("b",22,{account_slug:"dbcinema",is_obsolete:true})]],
 ["timestamp order differs",[row("a",25,{created_at:21}),row("b",22,{created_at:29}),row("c",21,{created_at:1})]],
 ["creation ties",[row("b",21),row("a",21)]],
 ["irrelevant import burst",[...Array.from({length:1000},(_,i)=>row(`unrelated${i}`,30+i,{order_step:"RETURNED",awaiting_owner_action:false})),row("wanted",21)]],
 ["unbounded relevant rows",Array.from({length:300},(_,i)=>row(String(i),21+i,{awaiting_owner_action:true}))],
];
describe.each([false,true])("indexed request candidates packed=%s",packed=>{
 it.each(cases)("preserves exact old values, deduplication and order: %s",async(_name,rows)=>{const f=await fixture(rows,packed);expect(await loadReplyQueueRequestRows(f.ctx,cutoff)).toEqual(previous(rows));expect(f.reads.some(r=>r.index==="by_creation_time"||r.index==="by_source_creation_time")).toBe(false);});
 it("excludes unrelated recent records before reading their payloads",async()=>{const f=await fixture(cases[10][1],packed);await loadReplyQueueRequestRows(f.ctx,cutoff);expect(f.reads.flatMap(r=>r.ids).some(id=>id.startsWith("unrelated"))).toBe(false);expect(f.reads.filter(r=>r.table===(packed?"reservation_read_records":"reservations"))).toHaveLength(4);});
});
