import { describe, expect, it } from "vitest";
import { confirmedChatClock, recoverConfirmedChatClock } from "./booking-schedule-evidence";
import { calendarClock, confirmedClock } from "../../convex/lib/confirmed_schedule";
import type { BookingTimeMessage } from "./booking-time-transcript";
const date = "2026-10-18";
const at = (hour: number, minute = 0) => Date.parse(`${date}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00+01:00`);
const row = (sender: string, body_text: string, stamp: number): BookingTimeMessage => ({sender, body_text, hygglo_sent_at: stamp});
const initial = [
 row("renter", "We would want a 8am pickup and drop off sometime after 5pm. If that's alright I'll confirm with my colleague and then book it in the system", at(6)),
 row("owner", "Yes that works!", at(6,10)),
 row("renter", "Great thanks!", at(6,15)),
 row("owner", "We can meet in front of the pub", at(6,20)),
 row("renter", "Sounds good, thank you!", at(6,25)),
];
const recover = (messages: BookingTimeMessage[], side: "pickup" | "return" = "pickup") => recoverConfirmedChatClock(messages,side,date,"hash");
describe("contextual booking schedule corrections", () => {
 it("repairs Mason's exact accepted late update without fabricating PM or exact inventory precision", () => {
  const messages = [...initial,
   row("renter", "Hi Dan, sorry for the last minute update I'm running a bit late and will be with you more like 9",at(7,45)),
   row("owner", "Ok all good",at(7,56)),
   row("renter", "I've just got to the pub",at(9,14)),
   row("renter", "No problem I'm wearing green",at(9,25)),
   row("owner", "Ok apologies I will just be there in a few minutes",at(9,23)),
  ];
  const proof = recover(messages);
  expect(proof).toMatchObject({time:"09:00",date,precision:"approximate",confirmedAt:at(7,56)});
  expect(recover(messages,"return")).toBeUndefined(); // "after 5" is a bound
  const rental={pickup_time:proof!.time,pickup_time_provenance:proof};
  expect(calendarClock(rental,"pickup",date)).toEqual({time:"09:00",status:"approximate"});
  expect(confirmedClock(rental,"pickup",date)).toBeUndefined();
 });
 it.each(["pickup around 9", "pickup about 9", "pickup at 9ish", "pickup roughly 9am"])("preserves approximate precision: %s", text => {
  expect(recover([...initial,row("renter",text,at(7,40)),row("owner","No problem",at(7,50))])).toMatchObject({time:"09:00",precision:"approximate"});
 });
 it.each(["Running late, pickup at 9am instead", "I will be there at 9 instead", "I am running late and will be with you at 9"])("accepts clear rescheduling: %s", text => {
  expect(recover([...initial,row("renter",text,at(7,40)),row("owner","Yes that works",at(7,50))])).toMatchObject({time:"09:00"});
 });
 it("invalidates the old proof while the newer correction is unaccepted", () => {
  expect(recover([...initial,row("renter","Running late, will be with you more like 9",at(7,45))])).toBeUndefined();
 });
 it("rejects a conditional owner answer", () => {
  expect(recover([...initial,row("renter","Running late, will be with you more like 9",at(7,45)),row("owner","Ok but could you make 10am?",at(7,50))])).toBeUndefined();
 });
 it.each(["I am 10 minutes away", "On my way, ETA 9am", "I will be there at 9", "I have arrived"])("keeps travel updates from replacing an agreed time: %s", text => {
  expect(recover([...initial,row("renter",text,at(7,45)),row("owner","Ok",at(7,50))])).toMatchObject({time:"08:00"});
 });
 it("does not infer an unsupported bare hour or a clock from equipment quantities", () => {
  for(const text of ["Pickup at 9", "Pickup at 9 batteries", "Pickup at 9 minutes", "Pickup on 9 October"])
   expect(recover([row("renter",text,at(7)),row("owner","Yes!",at(7,1))])).toBeUndefined();
 });
 it("uses the accepted evening daypart for a bare-hour correction", () => {
  const messages=[row("renter","Pickup at 7pm",at(16)),row("owner","Yes!",at(16,1)),row("renter","Running late, will be with you more like 9",at(18)),row("owner","Ok",at(18,1))];
  expect(recover(messages)).toMatchObject({time:"21:00",precision:"approximate"});
 });
 it("can correct a return without changing the pickup", () => {
  const messages=[...initial,row("renter","Return at 5pm",at(10)),row("owner","Yes!",at(10,1)),row("renter","Running late will be with you more like 6",at(16)),row("owner","Ok all good",at(16,1))];
  expect(recover(messages,"return")).toMatchObject({time:"18:00",precision:"approximate"});
  expect(recover(messages)).toMatchObject({time:"08:00"});
 });
 it("uses sent chronology when an import inserts the acceptance before the proposal", () => {
  const proposal=row("renter","Pickup at 9am instead",at(7,45)), acceptance=row("owner","Ok all good",at(7,50));
  expect(recover([...initial,acceptance,proposal])).toMatchObject({time:"09:00",confirmedAt:at(7,50)});
 });
 it("uses independent saved proof when the first agreement has left the 32-message window",()=>{
  const messages=[row("renter","I am running late, will be with you more like 9",at(7,45)),row("owner","Ok all good",at(7,50))];
  expect(recoverConfirmedChatClock(messages,"pickup",date,"hash",{time:"08:00",date,confirmedAt:at(6)})).toMatchObject({time:"09:00",precision:"approximate"});
  expect(recoverConfirmedChatClock(messages,"pickup",date,"hash",{time:"08:00",date,confirmedAt:at(8)})).toBeUndefined();
 });
 it("recovers an accepted named-weekday reschedule within booking tolerance",()=>{
  const messages=[row("renter","Pickup Monday at 9am instead",at(7)),row("owner","Yes!",at(7,1))];
  expect(recover(messages)).toMatchObject({date:"2026-10-19",time:"09:00"});
 });
 it("does not treat an approximate or bounded schedule as a precise stock release", () => {
  for(const text of ["Return after 5pm", "Return before 5pm", "Return by 5pm", "Return 5-6pm"])
   expect(confirmedChatClock([row("renter",text,at(7)),row("owner","Yes",at(7,1))],"return","17:00",date,date,"hash")).toBeUndefined();
 });
});
