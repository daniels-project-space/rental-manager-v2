import { v, type Infer } from "convex/values";
import { inclusiveRentalDays } from "./hygglo_pricing";
import { summarise, type PricedOrderLine } from "./renter_order_quote";

export const bookingRecordValidator = v.object({
  thread_id:v.string(),account_slug:v.string(),stage:v.union(v.literal("COMPLETED"),v.literal("CANCELLED"),v.literal("VERIFICATION_FAILED")),
  start_date:v.string(),end_date:v.string(),total_gbp:v.union(v.number(),v.null()),
  amount_basis:v.union(v.literal("recorded_paid"),v.literal("lab_quote"),v.literal("unknown")),
});
export type BookingRecord = Infer<typeof bookingRecordValidator>;

/** Historical money comes from the original order, never today's catalogue.
 * The Lab's captured quote is deliberately distinguished from money paid. */
export function bookingRecord(thread:string,account:string,stage:string,
 booking:{hygglo_order_id?:string;account_slug?:string;start_date?:string;end_date?:string;gross_paid_gbp?:number;currency?:string}|null,
 lab:{account_slug:string;start_date?:string;end_date?:string;items:PricedOrderLine[]}|null):BookingRecord|null {
 if(!["COMPLETED","CANCELLED","VERIFICATION_FAILED"].includes(stage)||!booking||booking.hygglo_order_id!==thread||booking.account_slug&&booking.account_slug!==account||lab&&(!thread.startsWith("__probe__")||lab.account_slug!==account))return null;
 const start=lab?.start_date??booking.start_date,end=lab?.end_date??booking.end_date;
 if(!start||!end||inclusiveRentalDays(start,end)===null)return null;
 const paid=booking.gross_paid_gbp;
 if((booking.currency??"GBP").toUpperCase()==="GBP"&&typeof paid==="number"&&Number.isFinite(paid)&&paid>=0)
  return {thread_id:thread,account_slug:account,stage:stage as BookingRecord["stage"],start_date:start,end_date:end,total_gbp:paid,amount_basis:"recorded_paid"};
 const quote=lab?.items.length?summarise(lab.items,start,end):null;
 const total=quote&&!quote.unpriced.length&&typeof quote.total_gbp==="number"&&Number.isFinite(quote.total_gbp)&&quote.total_gbp>=0?quote.total_gbp:null;
 return {thread_id:thread,account_slug:account,stage:stage as BookingRecord["stage"],start_date:start,end_date:end,total_gbp:total,amount_basis:total===null?"unknown":"lab_quote"};
}

export function bookingRecordText(record:BookingRecord):string {
 const date=(iso:string)=>new Intl.DateTimeFormat("en-GB",{day:"numeric",month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(`${iso}T12:00:00Z`));
 const period=record.start_date===record.end_date?date(record.start_date):`${date(record.start_date)} to ${date(record.end_date)}`;
 const amount=record.total_gbp===null?"Historical total is not recorded.":`${record.amount_basis==="recorded_paid"?"Recorded gross paid amount":"Recorded quoted total"}: £${record.total_gbp.toFixed(2).replace(/\.00$/,"")}`;
 const label=record.stage==="COMPLETED"?"Completed rental":record.stage==="CANCELLED"?"Cancelled rental request":"Verification-failed rental request";
 return `${label} record (${period}):\n${amount}`;
}

/** Only the exact Native historical block can be removed from prospective
 * quote validation. Any edit, added amount or reuse elsewhere stays checked. */
export function withoutBookingRecord(text:string,record?:BookingRecord|null):string {
 if(!record)return text;
 const block=bookingRecordText(record),at=text.indexOf(block);
 if(at<0||text.indexOf(block,at+block.length)>=0)return text;
 return text.slice(0,at)+block.replace(/[^\n]/g," ")+text.slice(at+block.length);
}
export function hasSingleBookingRecord(text:string,record:BookingRecord):boolean {
 const block=bookingRecordText(record),at=text.indexOf(block);
 return at>=0&&text.indexOf(block,at+block.length)<0;
}
