import {ownerCheckRequestMessageId} from "./lib/owner_check_request";
import {assessCameraRequirements,hasCameraRequirements,verifiedCameraCapabilities} from "./lib/camera_requirements";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query, mutation } from "./owner_functions";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { ownerCheckKey, ownerCheckScopeKey, ownerCheckValidator, listingMappingOwnerCheck, type OwnerCheck } from "./lib/owner_checks";
import { internalQuery } from "./_generated/server";
import { lensReadinessSubject } from "./lib/catalogue_readiness";
import { assessLensRequirements, hasLensRequirements, verifiedLensCapabilities } from "./lib/lens_requirements";
import { sameMount } from "./lib/item_name_match";
import { getBotBooking, getLabOrder, requestedListingContext } from "./lib/renter_booking";
import { loadListingInventory } from "./lib/listing_inventory";
import { draftContextKey } from "./lib/draft_review";
import { recentThreadMessages } from "./lib/thread_messages";
/** Workflow state only. Handling notes and equipment facts are deliberately
 * absent: marking a task handled does not attest a specification or quote. */
export async function ownerChecksForBot(ctx:QueryCtx,threadId:string,contextKey:string) {
 // Unresolved work must not disappear behind a rolling window of handled tasks.
 const [pending,handled]=await Promise.all([
  ctx.db.query("renter_bot_owner_checks").withIndex("by_status_thread",q=>q.eq("status","pending").eq("thread_id",threadId)).order("desc").collect(),
  ctx.db.query("renter_bot_owner_checks").withIndex("by_status_thread",q=>q.eq("status","handled_by_owner").eq("thread_id",threadId)).order("desc").take(20),
 ]);
 const tasks=[...pending,...handled];
 return tasks.map(task=>({task_id:task._id,status:task.status,kind:task.check.kind,product_id:task.check.kind==="listing_mapping"?task.check.product_id:null,
  requirements:task.check.kind==="listing_mapping"?null:task.check.requirements,lens_mount:task.check.kind==="listing_mapping"?null:task.check.lens_mount,
  start_date:task.check.start_date,end_date:task.check.end_date,quantity:task.check.quantity,candidate_names:task.candidate_names,
  context_changed:task.source_context_key!==contextKey,source_message_id:task.source_message_id,last_requested_message_id:ownerCheckRequestMessageId(task),
  specification_result_verified:false,customer_input_required:false}));
}
/** Recompute capability absence from current Native inventory, independently
 * of model prose, tool-use booleans, stock results and prices. */
export const readinessEvidence=internalQuery({args:{checks:v.array(ownerCheckValidator)},handler:async(ctx,a)=>{
 if(!a.checks.some(check=>check.kind==="lens_recommendation"))return [];
 const inventory=await ctx.db.query("items").collect();
 const owned=inventory.filter(i=>i.kind==="lens"&&i.status==="active"&&!i.is_marketing_only&&i.qty>0);
 const profiles=await Promise.all(owned.map(async item=>{
  const specs=await ctx.db.query("item_specs").withIndex("by_item",q=>q.eq("item_id",item._id)).collect();
  return {item,cap:verifiedLensCapabilities(specs.length===1?specs[0]:undefined,item.name_canonical)};
 }));
 return a.checks.flatMap(check=>{
  if(check.kind!=="lens_recommendation")return [];
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
 const [booking,order]=a.checks.some(c=>c.kind==="listing_mapping") ? await Promise.all([getBotBooking(ctx,a.thread_id),getLabOrder(ctx,a.thread_id)]) : [null,null];
 const request=requestedListingContext(booking,order,conv.inquiry_items);
 const pending=await ctx.db.query("renter_bot_owner_checks").withIndex("by_status_thread",q=>q.eq("status","pending").eq("thread_id",a.thread_id)).collect();
 const observed=await ctx.db.query("renter_bot_owner_checks").withIndex("by_last_request",q=>q.eq("thread_id",a.thread_id).eq("last_requested_message_id",a.message_id)).collect();
 let inventory: Doc<"items">[] | undefined;
 for(const check of a.checks) {
  if(!check.source_call_id||!Number.isInteger(check.quantity)||check.quantity<1||check.quantity>20)continue;
  const names:string[]=[];
  let verified:OwnerCheck=check;
  if(check.kind==="listing_mapping") {
   if(booking?.account_slug&&booking.account_slug!==conv.account_slug||check.start_date!==request.start_date||check.end_date!==request.end_date||!request.lines.some(l=>l.product_id===check.product_id&&l.qty===check.quantity))continue;
   inventory??=await ctx.db.query("items").collect();
   const physical=await loadListingInventory(ctx,conv.account_slug,check.product_id,check.quantity,{items:inventory});
   if(!listingMappingOwnerCheck(physical,check))continue;
   names.push(physical.listing_name!);
  } else {
  if(check.kind==="camera_recommendation" ? !hasCameraRequirements(check.requirements,check.lens_mount) : !hasLensRequirements(check.requirements))continue;
  const ids:typeof check.candidate_item_ids=[];
  for(const id of [...new Set(check.candidate_item_ids)]) {
   const item=await ctx.db.get(id);
   if(!item||item.status!=="active"||item.is_marketing_only||item.qty<=0)continue;
   if(check.kind==="camera_recommendation" ? !["camera","camera_body"].includes(item.kind??"") : item.kind!=="lens"||check.lens_mount&&!sameMount(item.lens_mount??"",check.lens_mount))continue;
   const specs=await ctx.db.query("item_specs").withIndex("by_item",q=>q.eq("item_id",id)).collect();
   const spec=specs.length===1?specs[0]:undefined;
   const assessment=check.kind==="camera_recommendation" ? assessCameraRequirements(verifiedCameraCapabilities(spec,item.name_canonical),check.requirements,check.lens_mount)
    : assessLensRequirements(verifiedLensCapabilities(spec,item.name_canonical),check.requirements);
   if(assessment.status!=="unknown")continue;
   ids.push(id);names.push(item.name_canonical);
  }
  if(!ids.length)continue;
  verified={...check,candidate_item_ids:ids};
  }
  // The original question is the audit anchor; the current request/context
  // fences retry identity. Human handling never becomes specification proof.
  if(observed.some(task=>task.status==="handled_by_owner"&&task.account_slug===conv.account_slug&&task.source_context_key===a.context_key&&ownerCheckScopeKey(task.check)===ownerCheckScopeKey(check)))continue;
  const key=ownerCheckKey(a.thread_id,a.message_id,check,a.context_key);
  const saved=await ctx.db.query("renter_bot_owner_checks").withIndex("by_key",q=>q.eq("key",key)).unique()
    ?? await ctx.db.query("renter_bot_owner_checks").withIndex("by_key",q=>q.eq("key",ownerCheckKey(a.thread_id,a.message_id,check))).unique();
  if(saved&&saved.source_context_key===a.context_key) {
    if(saved.status==="pending"&&saved.account_slug===conv.account_slug&&saved.source_context_key===a.context_key)
      await ctx.db.patch(saved._id,{check:verified,candidate_names:names,last_requested_message_id:a.message_id});
    continue;
  }
  const existing=pending.find(task=>task.account_slug===conv.account_slug&&task.source_context_key===a.context_key&&ownerCheckScopeKey(task.check)===ownerCheckScopeKey(check));
  if(existing) {
    // The original source question remains the audit anchor. Refresh candidates
    // from this Native result rather than creating another task on a follow-up.
    await ctx.db.patch(existing._id,{check:verified,candidate_names:names,last_requested_message_id:a.message_id});
    continue;
  }
  await ctx.db.insert("renter_bot_owner_checks",{thread_id:a.thread_id,account_slug:conv.account_slug,source_message_id:a.message_id,last_requested_message_id:a.message_id,source_context_key:a.context_key,
   source_epoch:a.epoch,key,check:verified,candidate_names:names,source_question:source.body_text??"",status:"pending",created_at:Date.now()});
 }
}
export const list=query({args:{account_slug:v.optional(v.string()),lab_only:v.optional(v.boolean()),paginationOpts:paginationOptsValidator},handler:async(ctx,a)=>{
 const result=a.lab_only ? (a.account_slug
  ? await ctx.db.query("renter_bot_owner_checks").withIndex("by_account_status_thread",q=>q.eq("account_slug",a.account_slug!).eq("status","pending").gte("thread_id","__probe__").lt("thread_id","__probe__\uffff")).paginate(a.paginationOpts)
  : await ctx.db.query("renter_bot_owner_checks").withIndex("by_status_thread",q=>q.eq("status","pending").gte("thread_id","__probe__").lt("thread_id","__probe__\uffff")).paginate(a.paginationOpts)) : a.account_slug ? await ctx.db.query("renter_bot_owner_checks").withIndex("by_account_status",q=>q.eq("account_slug",a.account_slug!).eq("status","pending")).paginate(a.paginationOpts)
  : await ctx.db.query("renter_bot_owner_checks").withIndex("by_status",q=>q.eq("status","pending")).paginate(a.paginationOpts);
 const inventory=result.page.some(t=>t.check.kind==="listing_mapping")?await ctx.db.query("items").collect():undefined;
 return {...result,page:await Promise.all(result.page.map(async task=>{
  const booking=await getBotBooking(ctx,task.thread_id),order=await getLabOrder(ctx,task.thread_id);
  const conv=await ctx.db.query("conversations").withIndex("by_thread",q=>q.eq("thread_id",task.thread_id)).first();
  const recent=await recentThreadMessages(ctx,task.thread_id,12),latestRenter=recent.filter(m=>m.sender==="renter").at(-1);
  const physical=task.check.kind==="listing_mapping"&&inventory?await loadListingInventory(ctx,task.account_slug,task.check.product_id,task.check.quantity,{items:inventory}):null;
  return {...task,mapping_details:physical?{complete:physical.complete,missing:physical.coverage?.missing??[],unresolved:[...(physical.coverage?.unresolved??[]),...physical.unresolved_default_adapters]}:null,
   context_changed:!conv||draftContextKey(booking,conv.inquiry_items,order)!==task.source_context_key,newer_renter_message:latestRenter?.message_id!==ownerCheckRequestMessageId(task),is_lab:task.thread_id.startsWith("__probe__")};
 }))};
}});
/** Records human handling, never verifies specs, sends a message or edits a rental. */
export const handle=mutation({args:{id:v.id("renter_bot_owner_checks"),note:v.string(),expected_request_message_id:v.string()},handler:async(ctx,a)=>{
 const note=a.note.trim();if(note.length<4||note.length>2000)throw new Error("Add a brief note about how you handled this check");
 const task=await ctx.db.get(a.id);if(!task)throw new Error("Check not found");if(task.status!=="pending")return {ok:true,already_handled:true};
 if(ownerCheckRequestMessageId(task)!==a.expected_request_message_id)throw new Error("This check changed while you were reviewing it. Reopen the handling form and review the current request.");
 const identity=await ctx.auth.getUserIdentity();
 await ctx.db.patch(task._id,{status:"handled_by_owner",handled_at:Date.now(),handled_by_auth_subject:identity?.subject,handling_note:note});return {ok:true,already_handled:false};
}});
