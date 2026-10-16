import { afterEach, describe, expect, it, vi } from "vitest";
import { pickupReminderEvent, rentalTimeChangedEvent, syncPickupReminder } from "./rental_timing_notifications";
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
  expect(pickupReminderEvent(rental,now-1)).toBeNull();expect(pickupReminderEvent(rental,now+60_000)).toBeNull();
 });
 it("does not remind for unknown clocks, requests, cancelled, returned or collected rentals", () => {
  for(const patch of [{pickup_time_provenance:undefined},{pickup_time:undefined},{pickup_time:"25:00"},{order_step:"REQUEST"},{is_obsolete:true},{status:"cancelled"},{status:"completed"},{order_step:"RETURNED"}])expect(pickupReminderEvent({...rental,...patch},now)).toBeNull();
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
  expect(changed.title).toBe("Your rental changed its time to 14:30");expect(changed.body).toContain("Pickup: 2035-07-01 · 13:00 → 2035-07-01 · 14:30");expect(changed.body).toContain("Return:");
  expect(rentalTimeChangedEvent(rental,{...rental,status:"cancelled",pickup_time:"14:00"},now)).toBeNull();
  expect(rentalTimeChangedEvent(rental,{...rental,pickup_time:"14:00"},Date.parse("2036-01-01"))).toBeNull();
 });
 it("keeps both new alerts out of both income-only lanes", () => {
  for(const type of ["pickup_reminder","rental_time_changed"] as const){expect(subscriptionReceivesNotification("all",type)).toBe(true);for(const mode of ["my_share","money_only"] as const)expect(subscriptionReceivesNotification(mode,type)).toBe(false);}
 });
 it("does not announce an unaccepted extracted clock or date as an agreed change",()=>{
  expect(rentalTimeChangedEvent(rental,{...rental,pickup_date:"2035-07-02",pickup_time:"14:00",pickup_time_provenance:undefined},now,true)).toBeNull();
 });
 it("projects, deduplicates, reschedules, cancels and restores only the owner reminder row",async()=>{
  vi.useFakeTimers();vi.setSystemTime(now);let saved:any=null;const patch=vi.fn(async(_id,fields)=>{Object.assign(saved,fields)});
  const ctx:any={db:{query:(table:string)=>{expect(table).toBe("rental_pickup_reminders");return {withIndex:()=>({first:async()=>saved})}},insert:async(table:string,fields:any)=>{expect(table).toBe("rental_pickup_reminders");saved={_id:"reminder",...fields};return saved._id},patch}};
  const row={...rental,_id:"rental"};await syncPickupReminder(ctx,row);expect(saved).toMatchObject({active:true,pickup_at:Date.parse("2035-07-01T12:00Z"),due_at:now});
  await syncPickupReminder(ctx,row);expect(patch).not.toHaveBeenCalled();
  const changed={...row,pickup_time:"14:00",pickup_time_provenance:{source:"provider_booking",date:"2035-07-01",time:"14:00",confirmedAt:2}};
  await syncPickupReminder(ctx,changed);expect(saved.pickup_at).toBe(Date.parse("2035-07-01T13:00Z"));
  await syncPickupReminder(ctx,{...changed,status:"cancelled"});expect(saved.active).toBe(false);
  await syncPickupReminder(ctx,changed);expect(saved.active).toBe(true);
  await syncPickupReminder(ctx,{...changed,pickup_time_provenance:undefined});expect(saved.active).toBe(false);
 });
 it("runs the real reminder handler with only indexed due projections", async () => {
  vi.useFakeTimers();vi.setSystemTime(now);const runAfter=vi.fn(),patch=vi.fn(),take=vi.fn(async count=>{expect(count).toBe(100);return [{_id:"reminder",reservation_id:"rental"}]});
  const withIndex=vi.fn((name,select)=>{expect(name).toBe("by_active_due");const selector:any={eq:(key:string,value:unknown)=>{expect([key,value]).toEqual(["active",true]);return selector},lte:(key:string,value:unknown)=>{expect([key,value]).toEqual(["due_at",now]);return selector}};select(selector);return {take}});
  await (checkPickups as any)._handler({db:{query:(table:string)=>{expect(table).toBe("rental_pickup_reminders");return {withIndex}},get:async()=>rental,patch},scheduler:{runAfter}},{});
  expect(queueNotificationEvents).toHaveBeenCalledWith(expect.anything(),[expect.objectContaining({type:"pickup_reminder"})]);
  expect(patch).toHaveBeenCalledWith("reminder",{active:false});expect(runAfter).not.toHaveBeenCalled();
 });
});
