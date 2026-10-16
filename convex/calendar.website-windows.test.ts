import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn(async () => null) } }));
import { computeStripLive, computeWeeklyLive, getGanttWeek, getCalendarStrip, getWeeklyCalendar, getItemAvailabilityForChat, searchCalendarInventory } from "./calendar";
import { computeViews } from "./mv/calendar";
import { websiteCalendarPeriods } from "./lib/reservations/itemUnits";
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);
const window = (id: string, start: string, end: string, clock: string | null, qty = 1) => ({ item_id: id, start: ms(start), end: ms(end), qty, pickupTime: "09:00", returnTime: clock });
const booking = { _id: "web-rental", _creationTime: 1, account_slug: "dbcinema_web", hygglo_order_id: "paid-web-rental", status: "confirmed", order_step: "DELIVERED", start_date: "2026-10-05", end_date: "2026-10-11", pickup_time: "08:00", return_time: "22:00", renter_name: "Client", gross_paid_gbp: 99,
  items: [{item_name: "Entire kit",qty: 1}], hygglo_items:[{name:"Entire kit",product_id:42}],
  site_item_windows: [window("camera", "2026-10-05", "2026-10-06", "12:00", 2), window("lens", "2026-10-05", "2026-10-06", "12:00"), window("camera", "2026-10-09", "2026-10-11", null), window("lens", "2026-10-09", "2026-10-11", "19:00")] };
const inventory = [{_id:"camera",name_canonical:"Sony FX3",kind:"camera",status:"active",qty:1,image_url:"https://images.example/camera.png"},{_id:"lens",name_canonical:"Canon 50mm",kind:"lens",status:"active",qty:1,image_url:"https://images.example/lens.png"}];
function context(rows: any[] = [booking], cache?: any, queryCounts?: Record<string, number>, queryOps?: Record<string, number>) {
 const tables: Record<string, any[]> = {reservations: rows, items: inventory,
  listing_images:[{account_slug:"dbcinema_web",product_id:42,image_url:"https://images.example/listing-42.png"},{account_slug:"leo",product_id:99,image_url:"https://images.example/unrelated.png"}],
  mv_calendar: cache ? [{key:Array.isArray(cache)?"strip:all":"weekly:all",anchor:"2026-10-05",days:7,payload:cache}] : []};
 return {db:{get: async () => null,query:(table:string)=>{
  if (queryCounts) queryCounts[table] = (queryCounts[table] ?? 0) + 1;
  let result=[...(tables[table]??[])]; let indexed=false; const index:any={}; for(const op of ["eq","gte","lte","lt","gt"]){index[op]=(field:string,value:any)=>{result=result.filter(r=>op==="eq"?r[field]===value:op==="gte"?r[field]>=value:op==="lte"?r[field]<=value:op==="lt"?r[field]<value:r[field]>value);return index;};}
  const q:any={withIndex:(name:string,fn:any)=>{indexed=true;if(queryOps)queryOps[`${table}.index.${name}`]=(queryOps[`${table}.index.${name}`]??0)+1;fn(index);return q;},collect:async()=>{if(!indexed&&queryOps)queryOps[`${table}.unindexedCollect`]=(queryOps[`${table}.unindexedCollect`]??0)+1;return result;},first:async()=>result[0]??null}; return q;
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
 it("loads Gantt listing images by the product keys present in the requested week",async()=>{
  const rental={...booking,_id:"gantt-image-rental",site_item_windows:undefined};
  const queryOps:Record<string,number>={};
  const result=await (getGanttWeek as any)._handler(context([rental],undefined,undefined,queryOps),{accountSlug:"dbcinema_web",weekStartIso:"2026-10-05"});
  const block=result.items.flatMap((item:any)=>item.blocks).find((row:any)=>row.reservation_id===rental._id);
  expect(block.set_tiles).toEqual([{name:"Entire kit",image_url:"https://images.example/listing-42.png",qty:1}]);
  expect(queryOps["listing_images.index.by_account_product"]).toBe(1);
  expect(queryOps["listing_images.unindexedCollect"]).toBeUndefined();
 });
 it("keeps an away equipment period visible while another item returns",async()=>{
  const mixed={...booking,site_item_windows:[window("camera","2026-10-05","2026-10-07","12:00"),window("lens","2026-10-05","2026-10-09","19:00")]};
  const days=await computeStripLive(context([mixed]),{accountSlug:"dbcinema_web",startDate:"2026-10-05",days:7});
  expect(days[2].returns).toHaveLength(1);expect(days[2].away).toHaveLength(1);expect(days[2].away[0].items[0].itemId).toBe("lens");
 });
 it("reuses compatible period-aware caches",async()=>{
  const cache=[{calendarWindowVersion:4,date:"2026-10-05",pickups:[],returns:[],away:[],holds:[]}];
  expect(await (getCalendarStrip as any)._handler(context([booking],cache),{accountSlug:null,startDate:"2026-10-05",days:7})).toEqual(cache);
  const weekly={calendarWindowVersion:4,days:[]};expect(await (getWeeklyCalendar as any)._handler(context([booking],weekly),{accountSlug:null,weekStartDate:"2026-10-05"})).toEqual(weekly);
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

it("preloads listing allocation once and shares the same mapping across refreshed views", async () => {
 const rental={...booking,_id:"leo-rental",account_slug:"leo",site_item_windows:undefined,
   hygglo_items:[{name:"Sony FX3",product_id:42}],items:[{item_name:"Sony FX3",qty:1}]};
 const counts:Record<string,number>={};
 const views=await (computeViews as any)._handler(context([rental],undefined,counts),{
   weekAnchor:"2026-10-05",stripAnchor:"2026-10-07",stripDays:7,slugs:["leo"],
 });
 const byKey=Object.fromEntries(views.map((view:any)=>[view.key,view.payload]));
 expect(counts.hygglo_product_context).toBe(1);
 expect(counts.online_listings).toBe(1);
 expect(counts.hygglo_products).toBe(1);
 expect(byKey["weekly:leo"]).toEqual(await computeWeeklyLive(context([rental]),{
   accountSlug:"leo",weekStartDate:"2026-10-05",
 }));
 expect(byKey["strip:leo"]).toEqual(await computeStripLive(context([rental]),{
   accountSlug:"leo",startDate:"2026-10-07",days:7,
 }));
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
 expect(strip[0].pickups).toHaveLength(1);expect(strip[0].calendarWindowVersion).toBe(4);
 const week=await (getWeeklyCalendar as any)._handler(context([pending],{calendarWindowVersion:3,days:[]}),{accountSlug:null,weekStartDate:'2026-10-05'});expect(week.calendarWindowVersion).toBe(4);expect(week.days[0].reservations).toHaveLength(1);
});


it("keeps saved native clocks through the real Gantt query while stock calendars stay conservative",async()=>{
 const native={...booking,_id:"native-rental",account_slug:"leo",hygglo_order_id:"native-order",site_item_windows:undefined,
   items:[{item_name:"Sony FX3",qty:1}],resolved_items:[{item_id:"camera",qty:1}],pickup_time:"09:15",return_time:"17:30"};
 const ctx=context([native]);
 const gantt=await(getGanttWeek as any)._handler(ctx,{weekStartIso:"2026-10-05",accountSlug:"leo"});
 const blocks=gantt.items.flatMap((i:any)=>i.blocks);
 expect(blocks.length).toBeGreaterThan(0);
 expect(blocks[0]).toMatchObject({pickup_time:"09:15",return_time:"17:30",pickup_time_status:"reported",return_time_status:"reported"});
 const week=await computeWeeklyLive(ctx,{accountSlug:"leo",weekStartDate:"2026-10-05"});
 expect(week.days[6].reservations[0].returnTime).toBeNull();
});

it("uses status/date indexes and retains rentals older than the former 120-day overlap scan",async()=>{
 const long={...booking,_id:"long-rental",account_slug:"leo",hygglo_order_id:"long-order",
   site_item_windows:undefined,start_date:"2026-01-01",end_date:"2026-10-10",
   items:[{item_name:"Sony FX3",qty:1}],resolved_items:[{item_id:"camera",qty:1}],
   hygglo_items:[{name:"Sony FX3",product_id:42}]};
 const ops:Record<string,number>={};
 const ctx=context([long],undefined,undefined,ops);
 const weekly=await computeWeeklyLive(ctx,{accountSlug:"leo",weekStartDate:"2026-10-05"});
 expect(weekly.days[0].reservations.map((r:any)=>r.reservationId)).toContain(long._id);

 const strip=await computeStripLive(ctx,{accountSlug:"leo",startDate:"2026-10-05",days:7});
 expect(strip[0].away.some((r:any)=>r.reservationId===long._id)).toBe(true);

 const gantt=await (getGanttWeek as any)._handler(ctx,{weekStartIso:"2026-10-05",accountSlug:"leo"});
 expect(gantt.items.flatMap((item:any)=>item.blocks).some((b:any)=>b.reservation_id===long._id)).toBe(true);

 const search=await (searchCalendarInventory as any)._handler(ctx,{
   query:"Sony FX3",weekStartIso:"2026-10-05",accountSlug:"leo",
 });
 expect(search.reservationIds).toContain(long._id);
 vi.setSystemTime(new Date("2026-10-05T10:00:00Z"));
 const chat=await (getItemAvailabilityForChat as any)._handler(context([long]),{
   query:"Sony FX3",horizonDays:7,accountSlug:"leo",
 });
 expect(chat.items[0].upcoming_bookings.some((b:any)=>b.return==="2026-10-10")).toBe(true);

 const views=await (computeViews as any)._handler(context([long],undefined,undefined,ops),{
   weekAnchor:"2026-10-05",stripAnchor:"2026-10-05",stripDays:7,slugs:["leo"],
 });
 const byKey=Object.fromEntries(views.map((view:any)=>[view.key,view.payload]));
 expect(byKey["weekly:leo"]).toEqual(await computeWeeklyLive(context([long]),{
   accountSlug:"leo",weekStartDate:"2026-10-05",
 }));
 expect(byKey["weekly:leo"].days[0].reservations.map((r:any)=>r.reservationId)).toContain(long._id);
 expect(ops["reservations.index.by_status_end_date"]).toBeGreaterThan(0);
 expect(ops["reservations.index.by_account_status_end_date"]).toBeGreaterThan(0);
 expect(ops["reservations.unindexedCollect"]).toBeUndefined();
});
