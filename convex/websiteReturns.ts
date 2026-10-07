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
async function websiteCall(type:"query"|"action",path:string,args:Record<string,unknown>):Promise<any> {
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
