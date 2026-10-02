import {describe,it,expect} from "vitest";
import {renterRequestsReadOnly} from "./renter_booking_consent";
const actions=["add_item","remove_item","set_dates"] as const;
describe("server message restrictions",()=>{
 it("keeps quote-only and no-booking-change messages read-only for every edit",()=>{
  for(const text of ["Quote only, do not change my booking.","Just a quote please.","Only an estimate please.","Don't edit anything yet.","Please quote it first.","No booking changes.","Don’t make any changes to my booking.","Please price it without making any changes.","Leave my booking unchanged.","Can you add the lens? Quote only for now."])
   for(const action of actions)expect(renterRequestsReadOnly(text,action),text).toBe(true);
 });
 it("does not turn a pricing question into an edit",()=>{
  for(const text of ["How much for another FX3?","Could you quote one extra body?","Before I decide, what would it cost?"])
   for(const action of actions)expect(renterRequestsReadOnly(text,action),text).toBe(true);
 });
 it("preserves explicit instructions and confirmation",()=>{
  for(const text of ["Please add the Sony FX3.","Yes please, add it.","Can you remove the Canon lens?","Please move the booking to 20 October.","How much for the FX3? Please add it."])
   expect(renterRequestsReadOnly(text,"add_item"),text).toBe(false);
 });
 it("keeps action-specific prohibitions from blocking another requested action",()=>{
  expect(renterRequestsReadOnly("Don't remove anything; please add the Sony FX3.","add_item")).toBe(false);
  expect(renterRequestsReadOnly("Don't remove anything; please add the Sony FX3.","remove_item")).toBe(true);
  expect(renterRequestsReadOnly("Don't change the dates; please add the lens.","add_item")).toBe(false);
  expect(renterRequestsReadOnly("Don't change the dates; please add the lens.","set_dates")).toBe(true);
 });
});
