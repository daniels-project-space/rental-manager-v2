import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn(async () => null) } }));
import { computeStripLive, computeWeeklyLive, getGanttWeek, getCalendarStrip, getWeeklyCalendar, getItemAvailabilityForChat } from "./calendar";
import { websiteCalendarPeriods } from "./lib/reservations/itemUnits";
import {custodyRenterKey,custodyUnitsKey} from "./lib/reservation_custody";
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);
const window = (id: string, start: string, end: string, clock: string | null, qty = 1) => ({ item_id: id, start: ms(start), end: ms(end), qty, pickupTime: "09:00", returnTime: clock });
const booking = { _id: "web-rental", _creationTime: 1, account_slug: "dbcinema_web", hygglo_order_id: "paid-web-rental", status: "confirmed", order_step: "DELIVERED", start_date: "2026-10-05", end_date: "2026-10-11", pickup_time: "08:00", return_time: "22:00", renter_name: "Client", gross_paid_gbp: 99,
  items: [{item_name: "Entire kit",qty: 1}], hygglo_items:[{name:"Entire kit",product_id:42}],
  site_item_windows: [window("camera", "2026-10-05", "2026-10-06", "12:00", 2), window("lens", "2026-10-05", "2026-10-06", "12:00"), window("camera", "2026-10-09", "2026-10-11", null), window("lens", "2026-10-09", "2026-10-11", "19:00")] };
const inventory = [{_id:"camera",name_canonical:"Sony FX3",kind:"camera",status:"active",qty:1,image_url:"https://images.example/camera.png"},{_id:"lens",name_canonical:"Canon 50mm",kind:"lens",status:"active",qty:1,image_url:"https://images.example/lens.png"}];
function context(rows: any[] = [booking], cache?: any) {
 const tables: Record<string, any[]> = {reservations: rows, items: inventory, mv_calendar: cache ? [{key:Array.isArray(cache)?"strip:all":"weekly:all",anchor:"2026-10-05",days:7,payload:cache}] : []};
 return {db:{get: async () => null,query:(table:string)=>{
  let result=[...(tables[table]??[])]; const index:any={}; for(const op of ["eq","gte","lte","lt","gt"]){index[op]=(field:string,value:any)=>{result=result.filter(r=>op==="eq"?r[field]===value:op==="gte"?r[field]>=value:op==="lte"?r[field]<=value:op==="lt"?r[field]<value:r[field]>value);return index;};}
  const q:any={withIndex:(_:string,fn:any)=>{fn(index);return q;},collect:async()=>result,first:async()=>result[0]??null}; return q;
 }}} as any;
}
beforeEach(()=>{vi.stubEnv("OWNER_AUTH_REQUIRED","false");vi.useFakeTimers();vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe("saved website calendar windows",()=>{
 it("groups only identical periods and clocks and keeps explicit nulls",()=>{
  const periods=websiteCalendarPeriods(booking); expect(periods).toHaveLength(3);expect(periods[0].site_item_windows).toHaveLength(2); expect(periods[1].return_time).toBeUndefined();expect(periods.every(p=>p._id===booking._id)).toBe(true);
  expect(websiteCalendarPeriods({...booking,site_item_windows:[]})).toEqual([]); expect(websiteCalendarPeriods({...booking,account_slug:"leo"})).toEqual([{...booking,account_slug:"leo"}]);
 });
 it("shows strip events for the correct equipment, dates and times with no gap occupancy",async()=>{
  const days=await computeStripLive(context(),{accountSlug:"dbcinema_web",startDate:"2026-10-05",days:7});
  expect(days[0].pickups).toHaveLength(1);expect(days[0].pickups[0].items.map(i=>[i.itemId,i.qty])).toEqual([["camera",2],["lens",1]]);
  expect(days[1].returns[0].returnTime).toBe("12:00");expect(days[2].away).toEqual([]);expect(days[3].away).toEqual([]);
  expect(days[4].pickups).toHaveLength(2); expect(days[6].returns.map(r=>r.returnTime)).toEqual([null,"19:00"]);
  expect(days[5].away).toHaveLength(2);expect(days.flatMap(d=>[...d.pickups,...d.returns,...d.away]).every(r=>r.reservationId===booking._id)).toBe(true);
 });
 it("shows weekly equipment quantities by period and omits booking-span gaps",async()=>{
  const result=await computeWeeklyLive(context(),{accountSlug:"dbcinema_web",weekStartDate:"2026-10-05"});
  expect(result.days[0].reservations).toHaveLength(1);expect(result.days[0].reservations[0].items.map(i=>i.qty)).toEqual([2,1]);
  expect(result.days[2].reservations).toEqual([]);expect(result.days[3].reservations).toEqual([]);
  expect(result.days[6].reservations.map(r=>r.returnTime)).toEqual([null,"19:00"]);expect(result.days[6].reservations.flatMap(r=>r.items).map(i=>i.qty)).toEqual([1,1]);
 });
 it("draws independent Gantt bars with original action IDs and period-specific thumbnails",async()=>{
  const result=await (getGanttWeek as any)._handler(context(),{accountSlug:"dbcinema_web",weekStartIso:"2026-10-05"});
  const camera=result.items.find((i:any)=>i.item_id==="camera");const lens=result.items.find((i:any)=>i.item_id==="lens");
  expect(camera.blocks).toHaveLength(2);expect(camera.blocks.map((b:any)=>b.qty)).toEqual([2,1]);expect(camera.blocks.map((b:any)=>[b.start_date,b.return_date,b.return_time])).toEqual([["2026-10-05","2026-10-06","12:00"],["2026-10-09","2026-10-11",null]]);
  expect(lens.blocks[1].return_time).toBe("19:00");expect(camera.blocks[0].logical_group_id).toBe(lens.blocks[0].logical_group_id);expect(camera.blocks[1].logical_group_id).not.toBe(lens.blocks[1].logical_group_id);
  expect(camera.blocks.every((b:any)=>b.reservation_id===booking._id && b.set_tiles===null)).toBe(true);
 });
 it("keeps an away equipment period visible while another item returns",async()=>{
  const mixed={...booking,site_item_windows:[window("camera","2026-10-05","2026-10-07","12:00"),window("lens","2026-10-05","2026-10-09","19:00")]};
  const days=await computeStripLive(context([mixed]),{accountSlug:"dbcinema_web",startDate:"2026-10-05",days:7});
  expect(days[2].returns).toHaveLength(1);expect(days[2].away).toHaveLength(1);expect(days[2].away[0].items[0].itemId).toBe("lens");
 });
 it("reuses compatible period-aware caches",async()=>{
  const cache=[{calendarWindowVersion:6,date:"2026-10-05",pickups:[],returns:[],away:[],holds:[]}];
  expect(await (getCalendarStrip as any)._handler(context([booking],cache),{accountSlug:null,startDate:"2026-10-05",days:7})).toEqual(cache);
  const weekly={calendarWindowVersion:5,days:[]};expect(await (getWeeklyCalendar as any)._handler(context([booking],weekly),{accountSlug:null,weekStartDate:"2026-10-05"})).toEqual(weekly);
 });
 it("chat availability reports the real gap and only upcoming physical periods",async()=>{
  const result=await (getItemAvailabilityForChat as any)._handler(context(),{query:"FX3",horizonDays:5,accountSlug:"leo"});
  expect(result.items).toHaveLength(1);const camera=result.items[0];
  expect(camera.free_today).toBe(true);expect(camera.free_units_today).toBe(1);expect(camera.next_free_date).toBe("2026-10-07");
  expect(camera.upcoming_bookings).toEqual([{renter:"Client",pickup:"2026-10-09 09:00",return:"2026-10-11",qty:1,account:"dbcinema_web"}]);
  const lens=await (getItemAvailabilityForChat as any)._handler(context(),{query:"Canon",horizonDays:5});
  expect(lens.items[0].upcoming_bookings[0].return).toBe("2026-10-11 19:00");
 });
 it("ignores pre-window calendar caches",async()=>{
  const args={accountSlug:null,startDate:"2026-10-05",days:7};
  const strip=await (getCalendarStrip as any)._handler(context([booking],[{date:"2026-10-05",pickups:[],returns:[],away:[],holds:[]}]),args);
  expect(strip[0].pickups).toHaveLength(1);
  const weekly=await (getWeeklyCalendar as any)._handler(context([booking],{days:[]}),{accountSlug:null,weekStartDate:"2026-10-05"});expect(weekly.days).toHaveLength(7);
 });
});


it('keeps paid website verification periods in strip, week, Gantt and chat stock while excluding unrelated pending enquiries',async()=>{
 const pending={...booking,status:'pending_review',order_step:'VERIFIED'};
 const unpaid={...pending,_id:'unpaid-other',account_slug:'leo',hygglo_order_id:'unpaid-other'};
 const ctx=context([pending,unpaid]);
 const strip=await computeStripLive(ctx,{accountSlug:null,startDate:'2026-10-05',days:7});expect(strip[0].pickups).toHaveLength(1);expect(strip[2].away).toEqual([]);
 const week=await computeWeeklyLive(ctx,{accountSlug:null,weekStartDate:'2026-10-05'});expect(week.days[0].reservations).toHaveLength(1);
 const gantt=await (getGanttWeek as any)._handler(ctx,{accountSlug:null,weekStartIso:'2026-10-05'});
 const blocks=gantt.items.flatMap((item:any)=>item.blocks);expect(blocks).toHaveLength(4);expect(blocks.every((b:any)=>b.reservation_id===booking._id && b.order_step==='VERIFIED')).toBe(true);
 vi.setSystemTime(new Date('2026-10-05T10:00:00Z'));
 const stock=await (getItemAvailabilityForChat as any)._handler(ctx,{query:'FX3',horizonDays:7});expect(stock.items[0].free_units_today).toBe(0);
});


it('rejects caches made before paid pending commitments were included',async()=>{
 const pending={...booking,status:'pending_review',order_step:'VERIFIED'};
 const strip=await (getCalendarStrip as any)._handler(context([pending],[{calendarWindowVersion:3,date:'2026-10-05',pickups:[],returns:[],away:[],holds:[]}]),{accountSlug:null,startDate:'2026-10-05',days:7});
 expect(strip[0].pickups).toHaveLength(1);expect(strip[0].calendarWindowVersion).toBe(6);
 const week=await (getWeeklyCalendar as any)._handler(context([pending],{calendarWindowVersion:3,days:[]}),{accountSlug:null,weekStartDate:'2026-10-05'});expect(week.calendarWindowVersion).toBe(5);expect(week.days[0].reservations).toHaveLength(1);
});

describe("grouped calendar tiles retain separate physical orders",()=>{
 const order=(id:string,extra:Record<string,unknown>={})=>({_id:id,_creationTime:1,hygglo_order_id:id,account_slug:"leo",renter_name:"Same renter",status:"confirmed",start_date:"2026-10-05",end_date:"2026-10-06",resolved_items:[{item_id:"camera",qty:1,confidence:1}],...extra});
 it("shows a confirmed continuous allocation once, plus an independent kit for the same renter",async()=>{
  const shared=[order("original"),order("extension")].map(row=>({...row,stock_custody_group_id:"original",stock_custody_provenance:{source:"owner_confirmation",account_slug:"leo",order_id:row.hygglo_order_id,renter_key:custodyRenterKey(row as any),units_key:custodyUnitsKey(new Map([["camera",1]])),start_date:row.start_date,end_date:row.end_date,confirmed_at:1,confirmed_by:"owner",note:"Owner confirmed the customer retained this same physical kit."}}));
  const days=await computeStripLive(context([...shared,order("independent")]),{accountSlug:"leo",startDate:"2026-10-05",days:2});
  expect(days[0].pickups[0].items.map(i=>i.qty)).toEqual([2]);
  shared[1].end_date="2026-10-07";
  const changed=await computeStripLive(context([...shared,order("independent")]),{accountSlug:"leo",startDate:"2026-10-05",days:2});
  expect(changed[0].pickups[0].items.map(i=>i.qty)).toEqual([3]);
 });
 it("sums duplicate unpictured listing lines within an individual order",async()=>{
  const rows=[order("one",{hygglo_items:[{name:"FX3",product_id:42,qty:1},{name:"FX3",product_id:42,qty:1}]}),order("two",{hygglo_items:[{name:"FX3",product_id:42,qty:1}]})];
  const days=await computeStripLive(context(rows),{accountSlug:"leo",startDate:"2026-10-05",days:2});
  expect(days[0].pickups[0].items.map(i=>i.qty)).toEqual([3]);
 });
 it("keeps one grouped tile with three independently booked bodies and an unknown return",async()=>{
  const proof=(time:string)=>({source:"agreed_chat",date:"2026-10-06",time,confirmedAt:1});
  const rows=[order("early",{return_time:"17:00",return_time_provenance:proof("17:00")}),order("later",{return_time:"19:00",return_time_provenance:proof("19:00")}),order("unknown")];
  const days=await computeStripLive(context(rows),{accountSlug:"leo",startDate:"2026-10-05",days:2});
  expect(days[0].pickups).toHaveLength(1);expect(days[1].returns).toHaveLength(1);
  expect(days[0].pickups[0].items.map(i=>[i.itemId,i.qty])).toEqual([["camera",3]]);
  expect(days[1].returns[0].items.map(i=>[i.itemId,i.qty])).toEqual([["camera",3]]);
  expect(days[1].returns[0].returnTime).toBeNull();
  expect(days[1].returns[0].returnTimeStatus).toBe("missing");
 });
 it("keeps saved return clocks unconfirmed when proof is absent or belongs to another date",async()=>{
  const rows=[
   order("no-proof",{renter_name:"No proof",return_time:"18:00"}),
   order("wrong-date",{renter_name:"Wrong date",return_time:"17:00",return_time_provenance:{source:"agreed_chat",date:"2026-10-05",time:"17:00",confirmedAt:1}}),
  ];
  const days=await computeStripLive(context(rows),{accountSlug:"leo",startDate:"2026-10-05",days:2});
  expect(days[1].returns.map(row=>row.returnTime)).toEqual([null,null]);
  expect(days[1].returns.map(row=>row.returnTimeStatus)).toEqual(["unconfirmed","unconfirmed"]);
  const grouped=[order("shared-one",{renter_name:"Shared renter",return_time:"16:00"}),order("shared-two",{renter_name:"Shared renter",return_time:"20:00"})];
  const groupedDays=await computeStripLive(context(grouped),{accountSlug:"leo",startDate:"2026-10-05",days:2});
  expect(groupedDays[1].returns).toHaveLength(1);
  expect(groupedDays[1].returns[0].returnTimeStatus).toBe("unconfirmed");
 });
 it("does not multiply sequential orders that occupy different calendar days",async()=>{
  const rows=[order("first",{end_date:"2026-10-05"}),order("second",{start_date:"2026-10-06"})];
  const days=await computeStripLive(context(rows),{accountSlug:"leo",startDate:"2026-10-05",days:2});
  expect(days[0].pickups[0].items.map(i=>i.qty)).toEqual([1]);expect(days[1].returns[0].items.map(i=>i.qty)).toEqual([1]);
 });
 it("preserves the latest accepted return clock together with its own provenance",async()=>{
  const rows=["17:00","19:00"].map((time,i)=>order(String(i),{return_time:time,return_time_provenance:{source:"agreed_chat",date:"2026-10-06",time,confirmedAt:i+1}}));
  const days=await computeStripLive(context(rows),{accountSlug:"leo",startDate:"2026-10-05",days:2});
  expect(days[1].returns[0].returnTime).toBe("19:00");expect(days[1].returns[0].items.map(i=>i.qty)).toEqual([2]);
 });
 it("keeps an unknown boundary unknown when a different kit has an agreed clock",async()=>{
  const rows=[order("camera"),order("lens",{resolved_items:[{item_id:"lens",qty:1,confidence:1}],return_time:"19:00",return_time_provenance:{source:"agreed_chat",date:"2026-10-06",time:"19:00",confirmedAt:1}})];
  const days=await computeStripLive(context(rows),{accountSlug:"leo",startDate:"2026-10-05",days:2});
  expect(days[1].returns).toHaveLength(1);expect(days[1].returns[0].returnTime).toBeNull();
 });
 it("combines different listing groups without losing the source quantities or lens",async()=>{
  const rows=[order("body-one"),order("body-two"),order("lens",{resolved_items:[{item_id:"lens",qty:2,confidence:1}]})];
  const days=await computeStripLive(context(rows),{accountSlug:"leo",startDate:"2026-10-05",days:2});
  expect(days[0].pickups).toHaveLength(1);
  expect(days[0].pickups[0].items.map(i=>[i.itemId,i.qty])).toEqual([["camera",2],["lens",2]]);
 });
 it("deduplicates copies of the same provider order before counting the grouped kit",async()=>{
  const rows=[order("one"),order("copy",{hygglo_order_id:"one",_creationTime:2}),order("two")];
  const days=await computeStripLive(context(rows),{accountSlug:"leo",startDate:"2026-10-05",days:2});
  expect(days[0].pickups[0].items.map(i=>i.qty)).toEqual([2]);
 });
 it("rejects the prior cache version without clock confirmation status",async()=>{
  const rows=[order("one"),order("two")],old=[{calendarWindowVersion:5,date:"2026-10-05",pickups:[],returns:[],away:[],holds:[]}];
  const days=await (getCalendarStrip as any)._handler(context(rows,old),{accountSlug:null,startDate:"2026-10-05",days:7});
  expect(days[0].calendarWindowVersion).toBe(6);expect(days[0].pickups[0].items.map((i:any)=>i.qty)).toEqual([2]);
 });
});
