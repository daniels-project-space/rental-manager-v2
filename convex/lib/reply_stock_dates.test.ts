import { describe,it,expect } from "vitest";
import {replyDatesFromMessage,replyStockWindow} from "./reply_stock_dates";
const message=(body_text:string,at="2026-10-13T18:00:00Z")=>({sender:"renter",body_text,hygglo_sent_at:Date.parse(at),message_id:"fixture"});
describe("rental dates recovered without changing bookings",()=>{
  it.each([
    ["Rent from Thursday morning til Saturday night","2026-10-15","2026-10-17"],
    ["Pickup Sat morning drop off Sunday morning","2026-10-17","2026-10-18"],
    ["Available for tomorrow?","2026-10-14","2026-10-14"],
    ["Tomorrow. Wednesday 14th Oct.","2026-10-14","2026-10-14"],
    ["Rent on 23/10/2026 and 24/10/2026","2026-10-23","2026-10-24"],
    ["Rent 12th-14th September","2026-09-12","2026-09-14"],
    ["Looking to rent Oct 11","2026-10-11","2026-10-11"],
    ["Pick up on 29th October afternoon then return on the 30th at 1pm","2026-10-29","2026-10-30"],
    ["Pick up on 29th October and return it next day at 1pm","2026-10-29","2026-10-30"],
    ["Shoot on 17 October. Collection on the evening of Friday 16 October and return on the evening of Saturday 17 October","2026-10-16","2026-10-17"],
    ["Rent 2026-10-20 to 2026-10-22","2026-10-20","2026-10-22"],
  ])("resolves %s",(text,start,end)=>expect(replyDatesFromMessage(message(text))).toMatchObject({start_date:start,end_date:end,source:"chat"}));
  it("anchors relative weekdays and tomorrow to the original provider timestamp",()=>{
    expect(replyDatesFromMessage(message("from saturday to monday","2026-10-09T18:17Z"))).toMatchObject({start_date:"2026-10-10",end_date:"2026-10-12"});
    expect(replyDatesFromMessage(message("next Thursday","2026-10-08T09:54Z"))).toMatchObject({start_date:"2026-10-15"});
    expect(replyDatesFromMessage(message("sat 17th","2026-10-14T17:26Z"))).toMatchObject({start_date:"2026-10-17"});
    expect(replyDatesFromMessage(message("tomorrow","2026-10-13T23:30Z"))).toMatchObject({start_date:"2026-10-15"});
  });
  it.each(["Need two tripods asap","Collect around 6:30pm?","Sony 70-200mm f2.8, 120cm softbox","Is the screen 17 inches?","Rent 31 February 2026","Rent 29 October to 28 October"]) ("does not invent dates for %s",text=>expect(replyDatesFromMessage(message(text))).toBeNull());
  it("does not infer relative dates from ingestion time or owner holiday messages",()=>{
    expect(replyDatesFromMessage({sender:"renter",body_text:"Tomorrow",message_id:"unstamped"})).toBeNull();
    expect(replyDatesFromMessage({...message("I'm away 28 to 31 October"),sender:"owner"})).toBeNull();
  });
  it("prefers booked dates, otherwise the latest complete renter proposal",()=>{
    const messages=[message("Need it 17 October"),message("Actually need it 19 October","2026-10-14T12:00Z")];
    expect(replyStockWindow({start_date:"2026-10-20",end_date:"2026-10-21"},messages,Date.now())).toMatchObject({source:"booking",start_date:"2026-10-20"});
    expect(replyStockWindow(null,messages,Date.now())).toMatchObject({source:"chat",start_date:"2026-10-19"});
  });
  it("labels today's stock explicitly when the renter never supplied dates",()=>expect(replyStockWindow(null,[message("What size is the screen?")],Date.parse("2026-10-15T20:00Z"))).toMatchObject({source:"today",start_date:"2026-10-15",end_date:"2026-10-15"}));
});


it("retains explicit requested clocks without inventing morning/evening times",()=>{
 expect(replyDatesFromMessage(message("Tomorrow, pick it up around 4pm and return it the same evening around 9:30pm"))).toMatchObject({start_date:"2026-10-14",pickup_time:"16:00",return_time:"21:30"});
 expect(replyDatesFromMessage(message("Thursday morning until Saturday night"))).not.toHaveProperty("pickup_time");
});
it("does not reinterpret alternative dates or restore an older proposal after an invalid change",()=>{
 expect(replyDatesFromMessage(message("Need 17 October or 19 October"))).toBeNull();
 expect(replyStockWindow(null,[message("Rent 17 October"),message("Actually need 29 October to 28 October","2026-10-14T12:00Z")],Date.parse("2026-10-15T20:00Z"))).toMatchObject({source:"today"});
});
