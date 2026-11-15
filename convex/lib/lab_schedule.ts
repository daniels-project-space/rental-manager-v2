import type {QueryCtx} from "../_generated/server";
import type {BotBooking} from "./renter_booking";
import {resolvePickupHours} from "../../src/lib/pickup-hours";
import {recoverConfirmedChatClock} from "../../src/lib/booking-schedule-evidence";
import {hashBookingTimeTranscript} from "../../src/lib/booking-time-transcript";

type Message={sender:string;body_text:string;hygglo_sent_at:number};
/** Use the same account/global opening-hours policy as the bot. A time is
 * confirmed only by conversation evidence, on a rental date, in a window. */
export async function confirmedLabTimes(ctx:QueryCtx,input:{account:string;startDate:string;endDate:string;booking:BotBooking|null;messages:Message[]}) {
 const account=await ctx.db.query("accounts").withIndex("by_slug",q=>q.eq("slug",input.account)).first();
 const profile=account ? await ctx.db.query("account_profiles").withIndex("by_account",q=>q.eq("account_id",account._id)).first() : null;
 const settings=await ctx.db.query("settings").first();
 const windows=resolvePickupHours(profile?.pickup_hours,settings?.pickup_hours);
 const hash=hashBookingTimeTranscript(input.messages);
 // Normalize common conversational wording only for this Lab view. Opening
 // windows are policy, not proposed clocks; "11am for pickup" attaches the
 // time to the following endpoint. The underlying transcript is unchanged.
 const normalized=input.messages.map(m=>({...m,body_text:m.body_text.replace(/\b(windows|hours)\s*\([^)]*\)/gi,"$1")
   .replace(/\b(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)\s+(?:for|as)\s+(pickup|pick\s*up|collection|return|drop\s*off)\b/gi,(_whole,time:string,side:string)=>`${side} at ${time}`)}));
 const pickup=recoverConfirmedChatClock(normalized,"pickup",input.startDate,hash,input.booking?.pickup_time_provenance);
 const returned=recoverConfirmedChatClock(normalized,"return",input.endDate,hash,input.booking?.return_time_provenance);
 const eligible=(proof:typeof pickup)=>!!proof && proof.precision!=="approximate" && proof.date>=input.startDate && proof.date<=input.endDate && windows.some(w=>proof.time>=w.start && proof.time<=w.end);
 let confirmedPickup=eligible(pickup)?pickup:undefined, confirmedReturn=eligible(returned)?returned:undefined;
 if(confirmedPickup && confirmedReturn && `${confirmedPickup.date}T${confirmedPickup.time}` > `${confirmedReturn.date}T${confirmedReturn.time}`){confirmedPickup=undefined;confirmedReturn=undefined;}
 return {pickup:confirmedPickup,returned:confirmedReturn};
}
