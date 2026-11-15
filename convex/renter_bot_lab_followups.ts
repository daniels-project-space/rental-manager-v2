import { internalMutation, query } from "./owner_functions";
import { v } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import { LAB_THREAD_PREFIX, getBotBooking } from "./lib/renter_booking";
import { recentThreadMessages } from "./lib/thread_messages";
import { rentalStage } from "./lib/rental_stage";
import { londonToday } from "./lib/effectiveDates";
import { summarise } from "./lib/renter_order_quote";
import { renterBotLabPickupPoint } from "./lib/renter_bot_lab_scenarios";
import { distanceFollowupDraft, missingTimeDraft, type LabTurn } from "./lib/lab_followup_policy";
import { confirmedLabTimes } from "./lib/lab_schedule";

const kindValidator=v.union(v.literal("missing_times"),v.literal("location"));
type Kind="missing_times"|"location";
function assertIsolated(thread:string) {
 if(!thread.startsWith(LAB_THREAD_PREFIX) || process.env.RENTER_BOT_LAB_SCENARIO_SEEDING!=="enabled")throw new Error("Only the isolated Lab can create follow-up drafts");
}
async function currentDraft(ctx:QueryCtx,thread_id:string,kind:Kind,anchor:number,source_message_id?:string) {
 const [booking,order,messages]=await Promise.all([
  getBotBooking(ctx,thread_id),ctx.db.query("renter_bot_lab_orders").withIndex("by_thread",q=>q.eq("thread_id",thread_id)).unique(),recentThreadMessages(ctx,thread_id,32),
 ]);
 if(!order?.start_date || !order.end_date)return null;
 const stage=rentalStage(booking,londonToday());
 if(["CANCELLED","VERIFICATION_FAILED","COMPLETED","IN_USE","RETURN_OVERDUE"].includes(stage.stage) || order.end_date<londonToday())return null;
 const chat=messages.map(m=>({sender:m.sender,body_text:m.body_text,hygglo_sent_at:m.hygglo_sent_at??m.fetched_at}));
 if(kind==="missing_times"){
  if(!booking || booking.created_at!==anchor)return null;
  const times=await confirmedLabTimes(ctx,{account:order.account_slug,startDate:order.start_date,endDate:order.end_date,booking,messages:chat});
  return missingTimeDraft({now:Date.now(),confirmedAt:anchor,confirmed:stage.booking_confirmed,startDate:order.start_date,endDate:order.end_date,
   pickupConfirmed:!!times.pickup,returnConfirmed:!!times.returned});
 }
 if(stage.booking_confirmed)return null;
 const history:LabTurn[]=messages.filter(m=>m.sender==="owner" || m.sender==="renter").map(m=>({role:m.sender as "owner"|"renter",content:m.body_text,at:m.hygglo_sent_at??m.fetched_at,messageId:m.message_id}));
 const last=history.at(-1);
 if(!last || last.messageId!==source_message_id || last.at!==anchor)return null;
 const total=summarise(order.items,order.start_date,order.end_date).total_gbp;
 return distanceFollowupDraft({now:Date.now(),history,pickupArea:renterBotLabPickupPoint(order.account_slug)?.area??null,rentalChargeGbp:total});
}

/** This scheduled job only saves an isolated draft; it has no send path. */
export const createDraft=internalMutation({
 args:{thread_id:v.string(),kind:kindValidator,anchor:v.number(),source_message_id:v.optional(v.string())},
 handler:async(ctx,a)=>{
  assertIsolated(a.thread_id);
  const existing=await ctx.db.query("renter_bot_lab_followup_drafts").withIndex("by_thread_kind",q=>q.eq("thread_id",a.thread_id).eq("kind",a.kind)).first();
  if(existing)return {created:false};
  const text=await currentDraft(ctx,a.thread_id,a.kind,a.anchor,a.source_message_id);
  if(!text)return {created:false};
  await ctx.db.insert("renter_bot_lab_followup_drafts",{...a,text,created_at:Date.now()});
  return {created:true};
 }
});

/** Suppress stale drafts if a time, price, booking or later message changes. */
export const list=query({
 args:{thread_id:v.string()},
 handler:async(ctx,{thread_id})=>{
  assertIsolated(thread_id);
  const rows=await ctx.db.query("renter_bot_lab_followup_drafts").withIndex("by_thread",q=>q.eq("thread_id",thread_id)).collect();
  const evaluated=await Promise.all(rows.map(async row=>({row,text:await currentDraft(ctx,thread_id,row.kind,row.anchor,row.source_message_id)})));
  return evaluated.filter(({row,text})=>text===row.text).map(({row})=>({kind:row.kind,text:row.text,created_at:row.created_at}));
 }
});
