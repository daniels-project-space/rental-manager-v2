import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query, mutation } from "./owner_functions";
import type { MutationCtx } from "./_generated/server";
import { ownerCheckKey, ownerCheckValidator, type OwnerCheck } from "./lib/owner_checks";
import { internalQuery } from "./_generated/server";
import { lensReadinessSubject } from "./lib/catalogue_readiness";
import { assessLensRequirements, hasLensRequirements, verifiedLensCapabilities } from "./lib/lens_requirements";
import { sameMount } from "./lib/item_name_match";
import { getBotBooking, getLabOrder } from "./lib/renter_booking";
import { draftContextKey } from "./lib/draft_review";
import { recentThreadMessages } from "./lib/thread_messages";
/** Recompute capability absence from current Native inventory, independently
 * of model prose, tool-use booleans, stock results and prices. */
export const readinessEvidence=internalQuery({args:{checks:v.array(ownerCheckValidator)},handler:async(ctx,a)=>{
 const inventory=await ctx.db.query("items").collect();
 const owned=inventory.filter(i=>i.kind==="lens"&&i.status==="active"&&!i.is_marketing_only&&i.qty>0);
 const profiles=await Promise.all(owned.map(async item=>{
  const specs=await ctx.db.query("item_specs").withIndex("by_item",q=>q.eq("item_id",item._id)).collect();
  return {item,cap:verifiedLensCapabilities(specs.length===1?specs[0]:undefined,item.name_canonical)};
 }));
 return a.checks.flatMap(check=>{
  const subject=lensReadinessSubject(check.requirements,check.lens_mount);
  if(!subject||!check.source_call_id||!hasLensRequirements(check.requirements))return [];
  const scope=profiles.filter(p=>!check.lens_mount||sameMount(p.item.lens_mount,check.lens_mount));
  if(scope.some(p=>assessLensRequirements(p.cap,check.requirements).status==="match"))return [];
  if(!scope.some(p=>check.candidate_item_ids.includes(p.item._id)&&assessLensRequirements(p.cap,check.requirements).status==="unknown"))return [];
  return [{subject,source_call_id:check.source_call_id}];
 });
}});
/** Same transaction as draft/review persistence; Native identities rechecked. */
export async function persistOwnerChecks(ctx:MutationCtx,a:{thread_id:string;message_id:string;epoch:number;context_key:string;checks:OwnerCheck[]}) {
 if(!a.checks.length)return;
 const conv=await ctx.db.query("conversations").withIndex("by_thread",q=>q.eq("thread_id",a.thread_id)).first();
 const [source]=await recentThreadMessages(ctx,a.thread_id,1);
 if(!conv?.account_slug||source?.message_id!==a.message_id||source.sender!=="renter")throw new Error("Owner check needs the current renter message");
 for(const check of a.checks) {
  if(!check.source_call_id||!hasLensRequirements(check.requirements)||!Number.isInteger(check.quantity)||check.quantity<1)continue;
  const ids:typeof check.candidate_item_ids=[],names:string[]=[];
  for(const id of [...new Set(check.candidate_item_ids)]) {
   const item=await ctx.db.get(id);
   if(!item||item.kind!=="lens"||item.status!=="active"||item.is_marketing_only||item.qty<=0||check.lens_mount&&!sameMount(item.lens_mount??"",check.lens_mount))continue;
   const specs=await ctx.db.query("item_specs").withIndex("by_item",q=>q.eq("item_id",id)).collect();
   if(assessLensRequirements(verifiedLensCapabilities(specs.length===1?specs[0]:undefined,item.name_canonical),check.requirements).status!=="unknown")continue;
   ids.push(id);names.push(item.name_canonical);
  }
  if(!ids.length)continue;
  const key=ownerCheckKey(a.thread_id,a.message_id,check);
  if(await ctx.db.query("renter_bot_owner_checks").withIndex("by_key",q=>q.eq("key",key)).unique())continue;
  await ctx.db.insert("renter_bot_owner_checks",{thread_id:a.thread_id,account_slug:conv.account_slug,source_message_id:a.message_id,source_context_key:a.context_key,
   source_epoch:a.epoch,key,check:{...check,candidate_item_ids:ids},candidate_names:names,source_question:source.body_text??"",status:"pending",created_at:Date.now()});
 }
}
export const list=query({args:{account_slug:v.optional(v.string()),lab_only:v.optional(v.boolean()),paginationOpts:paginationOptsValidator},handler:async(ctx,a)=>{
 const result=a.lab_only ? (a.account_slug
  ? await ctx.db.query("renter_bot_owner_checks").withIndex("by_account_status_thread",q=>q.eq("account_slug",a.account_slug!).eq("status","pending").gte("thread_id","__probe__").lt("thread_id","__probe__\uffff")).paginate(a.paginationOpts)
  : await ctx.db.query("renter_bot_owner_checks").withIndex("by_status_thread",q=>q.eq("status","pending").gte("thread_id","__probe__").lt("thread_id","__probe__\uffff")).paginate(a.paginationOpts)) : a.account_slug ? await ctx.db.query("renter_bot_owner_checks").withIndex("by_account_status",q=>q.eq("account_slug",a.account_slug!).eq("status","pending")).paginate(a.paginationOpts)
  : await ctx.db.query("renter_bot_owner_checks").withIndex("by_status",q=>q.eq("status","pending")).paginate(a.paginationOpts);
 return {...result,page:await Promise.all(result.page.map(async task=>{
  const booking=await getBotBooking(ctx,task.thread_id),order=await getLabOrder(ctx,task.thread_id);
  const conv=await ctx.db.query("conversations").withIndex("by_thread",q=>q.eq("thread_id",task.thread_id)).first();
  const recent=await recentThreadMessages(ctx,task.thread_id,12),latestRenter=recent.filter(m=>m.sender==="renter").at(-1);
  return {...task,context_changed:!conv||draftContextKey(booking,conv.inquiry_items,order)!==task.source_context_key,newer_renter_message:latestRenter?.message_id!==task.source_message_id,is_lab:task.thread_id.startsWith("__probe__")};
 }))};
}});
/** Records human handling, never verifies specs, sends a message or edits a rental. */
export const handle=mutation({args:{id:v.id("renter_bot_owner_checks"),note:v.string()},handler:async(ctx,a)=>{
 const note=a.note.trim();if(note.length<4||note.length>2000)throw new Error("Add a brief note about how you handled this check");
 const task=await ctx.db.get(a.id);if(!task)throw new Error("Check not found");if(task.status!=="pending")return {ok:true,already_handled:true};
 const identity=await ctx.auth.getUserIdentity();
 await ctx.db.patch(task._id,{status:"handled_by_owner",handled_at:Date.now(),handled_by_auth_subject:identity?.subject,handling_note:note});return {ok:true,already_handled:false};
}});
