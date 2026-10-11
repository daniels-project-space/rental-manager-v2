import {beforeEach,describe,it,expect,vi} from "vitest";
// Exercise the real handlers against an isolated preference store. Public
// owner enforcement is separately checked by check:owner-auth.
vi.mock("./owner_functions",()=>({query:(definition:unknown)=>definition,mutation:(definition:unknown)=>definition}));
import {hide,getForThreads} from "./quick_reply_thread_state";
const handler=(registration:unknown)=>(registration as {handler:(ctx:any,args:any)=>Promise<any>}).handler;
function store() {
  const records=new Map<string,any>();let reads=0;
  return {records,get reads(){return reads;},ctx:{db:{
    query:(table:string)=>{expect(table).toBe("quick_reply_thread_state");return {withIndex:(index:string,select:any)=>{expect(index).toBe("by_thread");let id="";select({eq:(field:string,value:string)=>{expect(field).toBe("thread_id");id=value;}});return {first:async()=>{reads++;return records.get(id)??null;}};}};},
    insert:async(table:string,row:any)=>{expect(table).toBe("quick_reply_thread_state");records.set(row.thread_id,{...row,_id:row.thread_id});},
    patch:async(id:string,row:any)=>{records.set(id,{...records.get(id),...row});},
  }}};
}
describe("durable queue preferences",()=>{
  beforeEach(()=>vi.useRealTimers());
  it("persists both sources without touching rental or conversation tables",async()=>{
    const db=store();
    await handler(hide)(db.ctx,{thread_id:"hygglo-order",through_renter_msg_at:100,reason:"declined"});
    await handler(hide)(db.ctx,{thread_id:"dbcinema:booking",through_renter_msg_at:200,reason:"dismissed"});
    expect(await handler(getForThreads)(db.ctx,{thread_ids:["hygglo-order","dbcinema:booking","absent"]})).toEqual({"hygglo-order":100,"dbcinema:booking":200,absent:null});
  });
  it("a delayed hide cannot overwrite a newer renter watermark",async()=>{
    const db=store();
    for(const through of [200,100])await handler(hide)(db.ctx,{thread_id:"order",through_renter_msg_at:through,reason:"dismissed"});
    expect(db.records.get("order").through_renter_msg_at).toBe(200);
  });
  it("deduplicates bounded indexed reads and rejects excessive batches",async()=>{
    const db=store();
    await handler(getForThreads)(db.ctx,{thread_ids:["a","b","a"]});expect(db.reads).toBe(2);
    await expect(handler(getForThreads)(db.ctx,{thread_ids:Array(501).fill("a")})).rejects.toThrow("TOO_MANY_THREADS");expect(db.reads).toBe(2);
  });
  it("rejects malformed preferences before accessing storage",async()=>{
    const db=store();
    for(const fields of [{thread_id:""},{thread_id:"x".repeat(161)},{through_renter_msg_at:-1},{through_renter_msg_at:NaN},{through_renter_msg_at:Date.now()+120000}]) {
      await expect(handler(hide)(db.ctx,{thread_id:"a",through_renter_msg_at:100,reason:"dismissed",...fields})).rejects.toThrow("INVALID_THREAD_WATERMARK");
    }
    expect(db.reads).toBe(0);expect(db.records.size).toBe(0);
  });
});
