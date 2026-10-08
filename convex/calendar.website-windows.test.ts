import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth", () => ({ authComponent: { safeGetAuthUser: vi.fn(async () => null) } }));
import { computeStripLive, computeWeeklyLive, getGanttWeek, getCalendarStrip, getWeeklyCalendar, getItemAvailabilityForChat } from "./calendar";
import { websiteCalendarPeriods } from "./lib/reservations/itemUnits";
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
  const cache=[{calendarWindowVersion:3,date:"2026-10-05",pickups:[],returns:[],away:[],holds:[]}];
  expect(await (getCalendarStrip as any)._handler(context([booking],cache),{accountSlug:null,startDate:"2026-10-05",days:7})).toEqual(cache);
  const weekly={calendarWindowVersion:3,days:[]};expect(await (getWeeklyCalendar as any)._handler(context([booking],weekly),{accountSlug:null,weekStartDate:"2026-10-05"})).toEqual(weekly);
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
