import {afterEach,describe,expect,it,vi} from "vitest";
import {createDraft,list} from "./renter_bot_lab_followups";
const thread_id="__probe__followup";
function fixture(){
 const tables:Record<string,any[]>={
  renter_bot_lab_bookings:[{hygglo_order_id:thread_id,created_at:0,status:"confirmed",start_date:"2099-01-01",end_date:"2099-01-02"}],
  renter_bot_lab_orders:[{thread_id,account_slug:"dbcinema",start_date:"2099-01-01",end_date:"2099-01-02",items:[{name:"Camera",qty:1,daily_price_gbp:50,pricing_basis:"listing",origin:"seed"}],changes:[]}],
  hygglo_messages:[],renter_bot_lab_followup_drafts:[],accounts:[],account_profiles:[],settings:[],
 };
 const ctx={db:{query:(name:string)=>({first:async()=>tables[name][0]??null,withIndex:(_index:string,fn:any)=>{const criteria:Record<string,unknown>={};const q={eq:(k:string,v:unknown)=>{criteria[k]=v;return q;}};fn(q);const rows=()=>tables[name].filter(row=>Object.entries(criteria).every(([k,v])=>row[k]===v));return {unique:async()=>rows()[0]??null,first:async()=>rows()[0]??null,collect:async()=>rows()};}}),insert:async(name:string,row:any)=>{tables[name].push(row);return "saved";}}};
 return {tables,ctx};
}
afterEach(()=>{vi.unstubAllEnvs();vi.useRealTimers();});
describe("unsent Lab follow-up persistence",()=>{
 it("stores one due draft and hides it if the booking is cancelled",async()=>{
  vi.stubEnv("RENTER_BOT_LAB_SCENARIO_SEEDING","enabled");vi.useFakeTimers();vi.setSystemTime(86400000);
  const f=fixture(),args={thread_id,kind:"missing_times",anchor:0};
  expect(await (createDraft as any)._handler(f.ctx,args)).toEqual({created:true});
  expect(await (createDraft as any)._handler(f.ctx,args)).toEqual({created:false});
  expect((await (list as any)._handler(f.ctx,{thread_id}))[0].text).toContain("pickup and return times");
  f.tables.renter_bot_lab_bookings[0].status="cancelled";
  expect(await (list as any)._handler(f.ctx,{thread_id})).toEqual([]);
 });
 it("refuses real thread IDs and a backend without the isolated Lab flag",async()=>{
  vi.stubEnv("RENTER_BOT_LAB_SCENARIO_SEEDING","enabled");const f=fixture();
  await expect((createDraft as any)._handler(f.ctx,{thread_id:"real-renter",kind:"missing_times",anchor:0})).rejects.toThrow();
  vi.stubEnv("RENTER_BOT_LAB_SCENARIO_SEEDING","");
  await expect((createDraft as any)._handler(f.ctx,{thread_id,kind:"missing_times",anchor:0})).rejects.toThrow();
 });
 it("keeps a reminder when an agreed time is outside opening hours and removes it after both valid times are agreed",async()=>{
  vi.stubEnv("RENTER_BOT_LAB_SCENARIO_SEEDING","enabled");vi.useFakeTimers();vi.setSystemTime(86400000);
  const f=fixture(),args={thread_id,kind:"missing_times",anchor:0};
  const add=(sender:string,body_text:string,n:number)=>f.tables.hygglo_messages.push({thread_id,sender,body_text,message_id:String(n),fetched_at:n,hygglo_sent_at:n,_creationTime:n});
  add("renter","Pickup at 11am",1);add("owner","Yes!",2);add("renter","Return at 5pm",3);add("owner","Yes!",4);
  expect(await (createDraft as any)._handler(f.ctx,args)).toEqual({created:true});
  expect((await (list as any)._handler(f.ctx,{thread_id}))[0].text).toContain("return time");
  add("renter","Return at 7pm instead",5);add("owner","Yes!",6);
  expect(await (list as any)._handler(f.ctx,{thread_id})).toEqual([]);
 });
 it("recognizes both agreed times without treating the stated opening windows as appointments",async()=>{
  vi.stubEnv("RENTER_BOT_LAB_SCENARIO_SEEDING","enabled");vi.useFakeTimers();vi.setSystemTime(86400000);
  const f=fixture(),args={thread_id,kind:"missing_times",anchor:0};
  f.tables.hygglo_messages.push({thread_id,sender:"renter",body_text:"Can I pick up at 11am and return at 7pm on 1 January?",message_id:"1",fetched_at:1,_creationTime:1},
   {thread_id,sender:"owner",body_text:"Yes, 11am for pickup and 7pm for return work with our collection windows (10am to 12pm and 7pm to 9pm).",message_id:"2",fetched_at:2,_creationTime:2});
  f.tables.renter_bot_lab_orders[0].end_date="2099-01-01";
  expect(await (createDraft as any)._handler(f.ctx,args)).toEqual({created:false});
 });
});
