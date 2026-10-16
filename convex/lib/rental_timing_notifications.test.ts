import { afterEach, describe, expect, it, vi } from "vitest";
import { pickupReminderEvent, returnReminderEvent, rentalReminderEvent, rentalTimeChangedEvent, syncRentalReminders } from "./rental_timing_notifications";
import { subscriptionReceivesNotification, buildConfirmedBookingNotificationCopy } from "./notification_events";
import { checkPickups } from "../rental_timing_notifications";
vi.mock("../notifications", () => ({ queueNotificationEvents: vi.fn(async (_ctx, events) => events.length) }));
import { queueNotificationEvents } from "../notifications";
const now = Date.parse("2035-07-01T11:45:00Z"); // London 12:45 BST.
const rental: any = {hygglo_order_id:"fixture",account_slug:"diogo",status:"confirmed",order_step:"BOOKED_AFTER_VERIFIED",start_date:"2035-07-01",end_date:"2035-07-02",pickup_time:"13:00",return_time:"17:00",renter_name:"Fixture",pickup_time_provenance:{source:"provider_booking",date:"2035-07-01",time:"13:00",confirmedAt:1},return_time_provenance:{source:"provider_booking",date:"2035-07-02",time:"17:00",confirmedAt:1},items:[{item_name:"Sony FX3",qty:1}]};
afterEach(() => {vi.useRealTimers();vi.clearAllMocks();});
describe("owner rental schedule alerts", () => {
 it("restores equipment while showing exactly half the net income", () => {
  expect(buildConfirmedBookingNotificationCopy({itemName:"Sony FX3",accountSlug:"diogo",net:81,gross:100,mode:"my_share"})).toEqual({title:"🎉 Wohoo, you made £40.50!",body:"Sony FX3 on Diogo · Your 50% share"});
 });
 it("reminds at fifteen minutes, with item, account, renter and chat link", () => {
  expect(pickupReminderEvent(rental,now)).toMatchObject({type:"pickup_reminder",title:"You have a pickup in 15 minutes",event_key:"pickup15:diogo:fixture:2035-07-01T13:00",url:"/?thread=fixture&account=diogo"});
  expect(pickupReminderEvent(rental,now)?.body).toContain("Sony FX3 · Fixture · Diogo");
  expect(pickupReminderEvent(rental,now-1)).toBeNull();expect(pickupReminderEvent(rental,now+60_000)?.title).toBe("You have a pickup in 14 minutes");expect(pickupReminderEvent(rental,now+15*60_000)).toBeNull();
 });
 it("does not remind for unknown clocks, requests, cancelled, returned or collected rentals", () => {
  for(const patch of [{pickup_time:undefined},{pickup_time:"25:00"},{order_step:"REQUEST"},{is_obsolete:true},{status:"cancelled"},{status:"completed"},{order_step:"RETURNED"}])expect(pickupReminderEvent({...rental,...patch},now)).toBeNull();
 });
 it("uses the actual next-to-do Hygglo semantics rather than interpreting DELIVERED as past handover",()=>{
  expect(pickupReminderEvent({...rental,order_step:"DELIVERED"},now)).not.toBeNull();
  expect(pickupReminderEvent({...rental,account_slug:"dbcinema_web",order_step:"DELIVERED"},now)).toBeNull();
  expect(rentalTimeChangedEvent({...rental,order_step:"RETURNED"},{...rental,order_step:"RETURNED",return_time:"18:00",return_time_provenance:{source:"agreed_chat",date:"2035-07-02",time:"18:00",confirmedAt:2}},now)?.body).toContain("Return:");
 });
 it("keeps a large basket within a phone notification payload",()=>{
  const event=pickupReminderEvent({...rental,items:Array.from({length:20},()=>({item_name:"Camera 📷".repeat(50),qty:1}))},now)!;
  expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(2000);expect(event.body).toContain("18 more");
 });
 it("uses negotiated dates, website links, winter time and midnight", () => {
  expect(pickupReminderEvent({...rental,account_slug:"dbcinema_web",start_date:"2035-06-29",pickup_date:"2035-07-01"},now)?.thread_id).toBe("dbcinema:fixture");
  expect(pickupReminderEvent({...rental,start_date:"2035-01-01",pickup_time:"13:00",pickup_time_provenance:{source:"provider_booking",date:"2035-01-01",time:"13:00",confirmedAt:1}},Date.parse("2035-01-01T12:45Z"))).not.toBeNull();
  expect(pickupReminderEvent({...rental,start_date:"2035-07-02",pickup_time:"00:00",pickup_time_provenance:{source:"provider_booking",date:"2035-07-02",time:"00:00",confirmedAt:1}},Date.parse("2035-07-01T22:45Z"))).not.toBeNull();
  expect(pickupReminderEvent({...rental,start_date:"2035-03-25",pickup_time:"01:30",pickup_time_provenance:{source:"provider_booking",date:"2035-03-25",time:"01:30",confirmedAt:1}},Date.parse("2035-03-25T00:45Z"))).toBeNull();
 });
 it("records pickup/return changes separately without treating enrichment as a change", () => {
  expect(rentalTimeChangedEvent(rental,{...rental},now)).toBeNull();
  expect(rentalTimeChangedEvent({...rental,pickup_time:undefined},rental,now)).toBeNull();
  const changed=rentalTimeChangedEvent(rental,{...rental,account_slug:"dbcinema_web",pickup_time:"14:30",return_time:"18:00"},now)!;
  expect(changed.title).toBe("Fixture has changed their rental times to pickup 14:30 · return 18:00");expect(changed.body).toContain("Pickup: 2035-07-01 · 13:00 → 2035-07-01 · 14:30");expect(changed.body).toContain("Return:");
  expect(rentalTimeChangedEvent(rental,{...rental,status:"cancelled",pickup_time:"14:00"},now)).toBeNull();
  expect(rentalTimeChangedEvent(rental,{...rental,pickup_time:"14:00"},Date.parse("2036-01-01"))).toBeNull();
 });
 it("keeps both new alerts out of both income-only lanes", () => {
  for(const type of ["pickup_reminder","return_reminder","rental_time_changed"] as const){expect(subscriptionReceivesNotification("all",type)).toBe(true);for(const mode of ["my_share","money_only"] as const)expect(subscriptionReceivesNotification(mode,type)).toBe(false);}
 });
 it("does not announce an unaccepted extracted clock or date as an agreed change",()=>{
  expect(rentalTimeChangedEvent(rental,{...rental,pickup_date:"2035-07-02",pickup_time:"14:00",pickup_time_provenance:undefined},now,true)).toBeNull();
 });
 it("uses saved calendar clocks without loosening confirmed stock evidence",()=>{
  expect(pickupReminderEvent({...rental,pickup_time_provenance:undefined},now)).not.toBeNull();
 });
 it("adds returns before handover and while gear is out, but never after completion",()=>{
  const at=Date.parse("2035-07-02T15:45Z");
  for(const patch of [{},{order_step:"RETURNED"},{account_slug:"dbcinema_web",order_step:"DELIVERED"}]){
   expect(returnReminderEvent({...rental,...patch},at)).toMatchObject({type:"return_reminder",title:"You have a return in 15 minutes",event_key:expect.stringContaining("return15:")});
  }
  for(const patch of [{status:"completed"},{order_step:"REVIEWED"},{booking_status:"returned"},{status:"cancelled"},{return_time:undefined},{return_time:"25:00"}])expect(returnReminderEvent({...rental,...patch},at)).toBeNull();
 });
 it("keeps changes visible when the previous saved time lacks stock corroboration",()=>{
  const before={...rental,pickup_time_provenance:undefined};
  const after={...rental,pickup_time:"14:00",pickup_time_provenance:{...rental.pickup_time_provenance,time:"14:00"}};
  expect(rentalTimeChangedEvent(before,after,now,true)?.body).toContain("13:00 → 2035-07-01 · 14:00");
 });
 it("projects, deduplicates, reschedules, cancels and restores both reminder rows",async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);const saved:any[]=[];
  const patch=vi.fn(async(id,fields)=>Object.assign(saved.find(r=>r._id===id),fields));
  const ctx:any={db:{query:(table:string)=>{expect(table).toBe("rental_pickup_reminders");return {withIndex:()=>({take:async()=>saved})}},insert:async(table:string,fields:any)=>{expect(table).toBe("rental_pickup_reminders");const row={_id:String(saved.length),...fields};saved.push(row);return row._id},patch}};
  const row={...rental,_id:"rental"};await syncRentalReminders(ctx,row);
  expect(saved).toHaveLength(2);expect(saved[0]).toMatchObject({kind:"pickup",active:true,scheduled_at:Date.parse("2035-07-01T12:00Z"),due_at:now});expect(saved[1].kind).toBe("return");
  await syncRentalReminders(ctx,row);expect(patch).not.toHaveBeenCalled();
  saved[0].fired_schedule_key=saved[0].schedule_key;saved[0].active=false;await syncRentalReminders(ctx,row);expect(saved[0].active).toBe(false);
  const changed={...row,pickup_time:"14:00"};await syncRentalReminders(ctx,changed);expect(saved[0].scheduled_at).toBe(Date.parse("2035-07-01T13:00Z"));
  await syncRentalReminders(ctx,{...changed,status:"cancelled"});expect(saved.every(r=>!r.active)).toBe(true);
  await syncRentalReminders(ctx,changed);expect(saved.every(r=>r.active)).toBe(true);
  await syncRentalReminders(ctx,{...changed,pickup_time:undefined});expect(saved[0].active).toBe(false);expect(saved[1].active).toBe(true);
 });
 it("runs both reminder kinds with only indexed due projections",async()=>{
  const at=Date.parse("2035-07-02T15:45Z"),sameDay={...rental,start_date:"2035-07-02",pickup_time:"17:00",return_time:"17:00"};
  vi.useFakeTimers();vi.setSystemTime(at);const runAfter=vi.fn(),patch=vi.fn();
  const due=[{_id:"pickup",reservation_id:"rental",kind:"pickup",schedule_key:"2035-07-02T17:00"},{_id:"return",reservation_id:"rental",kind:"return",schedule_key:"2035-07-02T17:00"}];
  const withIndex=vi.fn((name,select)=>{expect(name).toBe("by_active_due");const selector:any={eq:()=>selector,lte:()=>selector};select(selector);return {take:async()=>due}});
  await (checkPickups as any)._handler({db:{query:()=>({withIndex}),get:async()=>sameDay,patch},scheduler:{runAfter}},{});
  expect(queueNotificationEvents).toHaveBeenCalledTimes(2);expect(queueNotificationEvents).toHaveBeenLastCalledWith(expect.anything(),[expect.objectContaining({type:"return_reminder"})]);expect(patch).toHaveBeenCalledTimes(2);expect(runAfter).not.toHaveBeenCalled();
 });
});
