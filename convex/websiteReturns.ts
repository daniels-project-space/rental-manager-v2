import { action, internalQuery, requireOwner } from "./owner_functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import type { Id } from "./_generated/dataModel";
const linkRef=makeFunctionReference<"query",{reservationId:Id<"reservations">},{bookingId:string}>("websiteReturns:link");

const inspectionItem = v.object({key:v.string(),condition:v.union(v.literal("good"),v.literal("issue")),details:v.string(),openCase:v.boolean()});
export const link = internalQuery({args:{reservationId:v.id("reservations")},handler:async(ctx,args)=>{
 const row=await ctx.db.get(args.reservationId);
 if(!row || row.account_slug!=="dbcinema_web" || !row.hygglo_order_id)throw Error("Select a DB Cinema website rental");
 if(row.status==="cancelled" || row.is_obsolete)throw Error("A cancelled rental cannot be returned");
 return {bookingId:row.hygglo_order_id};
} });
async function websiteCall(type:"query"|"action"|"mutation",path:string,args:Record<string,unknown>):Promise<any> {
 const url=process.env.DBCINEMA_CONVEX_URL,token=process.env.DBCINEMA_ADMIN_TOKEN;
 if(!url || !token)throw Error("The website return connection is not configured");
 const response=await fetch(`${url.replace(/\/$/,"")}/api/${type}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path,args:{...args,token},format:"json"}),signal:AbortSignal.timeout(type==="action"?90000:20000)});
 let body:any;try{body=await response.json()}catch{throw Error("The website returned an unreadable response. Reload the saved inspection before retrying.")}
 if(!response.ok || body.status!=="success")throw Error(typeof body.errorMessage==="string"?body.errorMessage.split(token).join("[redacted]").slice(0,500):"Website return request failed. Reload the saved inspection before retrying.");
 return body.value;
}
export const preview = action({args:{reservationId:v.id("reservations"),actualReturnedAt:v.optional(v.number())},handler:async(ctx,args):Promise<any>=>{
 await requireOwner(ctx,true);
 const {bookingId}=await ctx.runQuery(linkRef,{reservationId:args.reservationId});
 const data=await websiteCall("query","returnInspections:context",{bookingId,...(args.actualReturnedAt!==undefined?{actualReturnedAt:args.actualReturnedAt}:{})});
 return {...data,executionEnabled:process.env.ALLOW_WEBSITE_RETURN_WRITES==="true"};
} });
/** Read current provider balances and render a draft statement; no settlement writes. */
export const review = action({args:{reservationId:v.id("reservations"),actualReturnedAt:v.number(),damageKept:v.number(),damageNote:v.optional(v.string()),chargeLate:v.boolean(),lateWaiverReason:v.optional(v.string()),inspection:v.optional(v.array(inspectionItem))},handler:async(ctx,args):Promise<any>=>{
 await requireOwner(ctx,true);
 const {reservationId,...decision}=args;
 const {bookingId}=await ctx.runQuery(linkRef,{reservationId});
 return websiteCall("action","checkout:previewReturned",{bookingId,...decision});
} });
export const settle = action({args:{reservationId:v.id("reservations"),actualReturnedAt:v.number(),damageKept:v.number(),damageNote:v.optional(v.string()),chargeLate:v.boolean(),lateWaiverReason:v.optional(v.string()),inspection:v.optional(v.array(inspectionItem))},handler:async(ctx,args):Promise<any>=>{
 await requireOwner(ctx,true);
 if(process.env.ALLOW_WEBSITE_RETURN_WRITES!=="true")throw Error("Website return settlement is not enabled yet");
 const {reservationId,...decision}=args;
 const {bookingId}=await ctx.runQuery(linkRef,{reservationId});
 const context=await websiteCall("query","returnInspections:context",{bookingId});
 if(!["confirmed","active","returned"].includes(context.status))throw Error("The website rental is not available for return");
 if(!args.inspection && !context.returnDecision)throw Error("Inspect every item before settlement");
 const result=await websiteCall("action","checkout:markReturned",{bookingId,...decision});
 if(result?.ok!==true)throw Error("The website has not confirmed settlement; the rental remains open");
 let syncPending=false;
 try {
  const booking=await websiteCall("query","rmv2_sync:forRmv2SyncBooking",{bookingId});
  if(booking.status!=="returned")throw Error("Return status is not confirmed");
  await ctx.runMutation(internal.sync_dbcinema_web.upsertSiteBookingsBatch,{bookings:[booking],reconcile:false});
 } catch {syncPending=true;console.error("Website return settled; downstream update awaits durable website sync")}
 return {...result,syncPending};
} });

const caseLinkRef = makeFunctionReference<"query", {claimId:Id<"insurance_claims">}, {bookingId:string;caseId:string}>("websiteReturns:caseLink");
export const caseLink = internalQuery({args:{claimId:v.id("insurance_claims")},handler:async(ctx,args)=>{
 const claim=await ctx.db.get(args.claimId);
 if(!claim || claim.account_slug!=="dbcinema_web" || !claim.site_case_id || !claim.site_booking_id || !claim.reservation_id)throw Error("Select a linked website return case");
 const rental=await ctx.db.get(claim.reservation_id);
 if(!rental || rental.account_slug!=="dbcinema_web" || rental.hygglo_order_id!==claim.site_booking_id)throw Error("Website case rental binding mismatch");
 return {bookingId:claim.site_booking_id,caseId:claim.site_case_id};
} });
/** Resolve only the source damage case. It does not record a payout or change a settled deduction. */
export const closeDamageCase = action({args:{claimId:v.id("insurance_claims"),resolution:v.string()},handler:async(ctx,args):Promise<any>=>{
 await requireOwner(ctx,true);
 if(process.env.ALLOW_WEBSITE_RETURN_WRITES!=="true")throw Error("Website case resolution is not enabled yet");
 if(args.resolution.trim().length<10)throw Error("Record how the case was resolved.");
 const binding=await ctx.runQuery(caseLinkRef,{claimId:args.claimId});
 await websiteCall("mutation","returnInspections:closeCase",{...binding,resolution:args.resolution});
 let syncPending=false;
 try {
  const booking=await websiteCall("query","rmv2_sync:forRmv2SyncBooking",{bookingId:binding.bookingId});
  if(!booking.damageCases?.some((c:any)=>c.id===binding.caseId && c.status==="closed"))throw Error("Case closure not confirmed");
  await ctx.runMutation(internal.sync_dbcinema_web.upsertSiteBookingsBatch,{bookings:[booking],reconcile:false});
 } catch {syncPending=true;}
 return {ok:true,syncPending};
} });
