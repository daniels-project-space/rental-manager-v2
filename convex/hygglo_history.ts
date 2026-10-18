import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query, internalQuery, internalMutation } from "./owner_functions";
import { patchRevenueReservation } from "./lib/reservation_revenue";
import { isDead, isVerified } from "./order_step_semantics";

const image = v.object({url:v.string(),thumbnail:v.optional(v.string())});
const entry = v.object({id:v.string(),position:v.optional(v.number()),role:v.union(v.literal("owner"),v.literal("renter"),v.literal("system")),content:v.string(),hidden:v.optional(v.boolean()),title:v.optional(v.string()),timestamp:v.optional(v.number()),images:v.array(image)});
import type { MutationCtx, QueryCtx } from "./_generated/server";
const stateFor = (ctx:QueryCtx | MutationCtx, thread:string) => ctx.db.query("hygglo_history_state").withIndex("by_thread",q=>q.eq("thread_id",thread)).unique();
export const state = query({args:{thread_id:v.string()},handler:async(ctx,{thread_id})=>{
 const row=await stateFor(ctx,thread_id);return row?{ready:row.ready,count:row.entry_count,error:row.error??null,blocked:row.blocked??false}:null;
}});
export const page = query({args:{thread_id:v.string(),paginationOpts:paginationOptsValidator},handler:async(ctx,{thread_id,paginationOpts})=>{
 const result=await ctx.db.query("hygglo_history_entries").withIndex("by_thread_time",q=>q.eq("thread_id",thread_id)).order("desc").paginate({...paginationOpts,numItems:Math.min(80,paginationOpts.numItems)});
 return {...result,page:result.page.map(row=>({id:row.provider_id,position:row.position,role:row.role,content:row.content,title:row.title,timestamp:row.timestamp,hidden:row.hidden,images:row.images}))};
}});
export const context = internalQuery({args:{thread_id:v.string()},handler:async(ctx,{thread_id})=>{
 const reservation=await ctx.db.query("reservations").withIndex("by_hygglo_order_id",q=>q.eq("hygglo_order_id",thread_id)).first();
 const conversation=reservation?.account_slug?null:await ctx.db.query("conversations").withIndex("by_thread",q=>q.eq("thread_id",thread_id)).first();
 const account=reservation?.account_slug??conversation?.account_slug??(conversation?.account_id?(await ctx.db.get(conversation.account_id))?.slug:undefined);
 return account&&["dbcinema","diogo","leo"].includes(account)?{account,state:await stateFor(ctx,thread_id)}:null;
}});
export const claim = internalMutation({args:{thread_id:v.string(),account:v.string(),lease:v.string(),force:v.optional(v.boolean())},handler:async(ctx,args)=>{
 const row=await stateFor(ctx,args.thread_id),now=Date.now();
 if(row?.blocked&&!args.force)return false;
 if(row&&(now-(row.refreshed_at??0)<45_000||row.lease&&now-row.started_at<90_000))return false;
 const fields={thread_id:args.thread_id,account_slug:args.account,lease:args.lease,started_at:now,error:undefined,...(args.force?{blocked:undefined,failures:0}:{})};
 if(row)await ctx.db.patch(row._id,fields);else await ctx.db.insert("hygglo_history_state",{...fields,ready:false,entry_count:0});
 return true;
}});
export const writePage = internalMutation({args:{thread_id:v.string(),lease:v.string(),entries:v.array(entry)},handler:async(ctx,args)=>{
 if(args.entries.length>40)throw Error("History pages are limited to 40 entries");
 const state=await stateFor(ctx,args.thread_id);if(!state||state.lease!==args.lease)throw Error("Stale history refresh");
 let inserted=0,updated=0;
 for(const item of args.entries){
  const old=await ctx.db.query("hygglo_history_entries").withIndex("by_thread_id",q=>q.eq("thread_id",args.thread_id).eq("provider_id",item.id)).unique();
  const {id,...content}=item;
  const fields={...content,sort_at:item.timestamp??0,thread_id:args.thread_id,account_slug:state.account_slug,provider_id:id};
  if(!old){await ctx.db.insert("hygglo_history_entries",fields);inserted++;}
  else if(JSON.stringify([old.role,old.content,old.title,old.timestamp,old.images,old.hidden,old.position])!==JSON.stringify([item.role,item.content,item.title,item.timestamp,item.images,item.hidden,item.position])){await ctx.db.patch(old._id,fields);updated++;}
 }
 if(inserted)await ctx.db.patch(state._id,{entry_count:state.entry_count+inserted});
 return {inserted,updated};
}});
export const complete = internalMutation({args:{thread_id:v.string(),lease:v.string(),hash:v.string(),proof:v.object({paid:v.boolean(),verification_started:v.boolean(),platform_booking_confirmed:v.boolean()})},handler:async(ctx,args)=>{
 const state=await stateFor(ctx,args.thread_id);if(!state||state.lease!==args.lease)return false;
 await ctx.db.patch(state._id,{ready:true,lease:undefined,refreshed_at:Date.now(),source_hash:args.hash,error:undefined,blocked:undefined,failures:0});
 const rental=await ctx.db.query("reservations").withIndex("by_hygglo_order_id",q=>q.eq("hygglo_order_id",args.thread_id)).first();
 if(rental&&rental.account_slug===state.account_slug&&!rental.is_obsolete&&!isDead(rental.order_step)&&!["cancelled","declined"].includes(rental.status)){
  if(Object.entries(args.proof).some(([key,value])=>rental[key as keyof typeof rental]!==value))await patchRevenueReservation(ctx,rental._id,args.proof);
 }
 return true;
}});
export const failed = internalMutation({args:{thread_id:v.string(),lease:v.string(),permanent:v.optional(v.boolean())},handler:async(ctx,args)=>{
 const row=await stateFor(ctx,args.thread_id);if(row?.lease===args.lease)await ctx.db.patch(row._id,{lease:undefined,failures:(row.failures??0)+1,blocked:args.permanent===true||(row.failures??0)>=2,error:"Could not refresh the complete conversation. Please retry."});
}});

/** Repair old proof flags from the provider's already imported current workflow.
 * Booking status, dates, prices, returns and customer messages are untouched. */
export const repairKnownConfirmations = internalMutation({args:{reservation_ids:v.array(v.id("reservations"))},handler:async(ctx,{reservation_ids})=>{
 if(reservation_ids.length>50)throw Error("Repair up to 50 reservations");
 let changed=0;
 for(const id of [...new Set(reservation_ids)]){
  const row=await ctx.db.get(id);
  if(!row||row.is_obsolete||!["dbcinema","diogo","leo"].includes(row.account_slug??"")||!isVerified(row.order_step)||!["confirmed","ongoing","completed"].includes(row.status))continue;
  if(row.paid===true&&row.verification_started===true&&row.platform_booking_confirmed===true)continue;
  await patchRevenueReservation(ctx,id,{paid:true,verification_started:true,platform_booking_confirmed:true});changed++;
 }
 return {changed};
}});
