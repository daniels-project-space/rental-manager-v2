import {describe,it,expect} from "vitest";
import {bookingRecord,bookingRecordText,withoutBookingRecord,hasSingleBookingRecord} from "./booking_record";
import {unsupportedPriceClaims} from "./price_claims";
const booking={hygglo_order_id:"__probe__record",account_slug:"leo",start_date:"2026-10-01",end_date:"2026-10-02"};
const lab={account_slug:"leo",start_date:booking.start_date,end_date:booking.end_date,items:[{name:"TTArtisan 11mm",qty:1,daily_price_gbp:21,pricing_basis:"listing" as const}]};
const record=()=>bookingRecord(booking.hygglo_order_id,"leo","COMPLETED",booking,lab)!;
describe("Native historical rental records",()=>{
 it("uses captured Lab rates and never implies their quote was paid",()=>{
  expect(record()).toMatchObject({total_gbp:42,amount_basis:"lab_quote"});
  expect(bookingRecordText(record())).toContain("Recorded quoted total: £42");
  expect(bookingRecordText(record())).not.toContain("paid");
 });
 it("uses real recorded gross payment without a Lab order or current price lookup",()=>{
  const r=bookingRecord("real-order","leo","COMPLETED",{...booking,hygglo_order_id:"real-order",gross_paid_gbp:47.5},null)!;
  expect(bookingRecordText(r)).toContain("Recorded gross paid amount: £47.50");
  expect(bookingRecord("real-order","leo","COMPLETED",{...booking,hygglo_order_id:"real-order"},null)).toMatchObject({total_gbp:null,amount_basis:"unknown"});
 });
 it("preserves cancelled and verification-failed purposes without confirmation or refund claims",()=>{
  for(const stage of ["CANCELLED","VERIFICATION_FAILED"]) {
   const r=bookingRecord(booking.hygglo_order_id,"leo",stage,booking,lab)!;
   expect(r.stage).toBe(stage);expect(bookingRecordText(r)).not.toContain("Completed rental");
   expect(bookingRecordText(r)).not.toMatch(/refund|confirmed|paid/);
  }
 });
 it("rejects cross-thread/account snapshots, active stages and bad dates",()=>{
  expect(bookingRecord("other","leo","COMPLETED",booking,lab)).toBeNull();
  expect(bookingRecord(booking.hygglo_order_id,"other","COMPLETED",booking,lab)).toBeNull();
  expect(bookingRecord(booking.hygglo_order_id,"leo","IN_USE",booking,lab)).toBeNull();
  expect(bookingRecord(booking.hygglo_order_id,"leo","COMPLETED",{...booking,end_date:"2026-09-01"},null)).toBeNull();
 });
 it("separates the exact historical block from prospective price checks; edits or repeated blocks cannot borrow it",()=>{
  const r=record(),block=bookingRecordText(r),request={items:[{name:"TTArtisan 11mm",quantity:1}],start_date:"2026-10-22",end_date:"2026-10-24"};
  const prices=[{names:["TTArtisan 11mm"],kind:"rental" as const,total_gbp:60,days:3,quantity:1,start_date:request.start_date,end_date:request.end_date,call_id:"new-native",source:"native_inquiry_basket"}];
  const draft=block+"\n\nTTArtisan 11mm is £60 for 22 to 24 October.";
  expect(unsupportedPriceClaims(draft,prices,request,"",r)).toEqual([]);
  expect(unsupportedPriceClaims(draft.replace("£60","£42"),prices,request,"",r)).not.toEqual([]);
  expect(unsupportedPriceClaims(draft.replace("£42","£43"),prices,request,"",r)).not.toEqual([]);
  expect(withoutBookingRecord(block+"\n"+block,r)).toContain("£42");
  expect(hasSingleBookingRecord(block+"\n"+block,r)).toBe(false);
 });
});
