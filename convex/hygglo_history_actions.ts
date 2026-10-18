"use node";
import { v } from "convex/values";
import { action } from "./owner_functions";
import { internal } from "./_generated/api";
import { HyggloApiError, createHyggloCore } from "../src/hygglo-core";
import { hyggloHistoryEntries } from "./lib/hygglo_history_entries";
import { quickReplyProof } from "./lib/quick_reply_proof";
/** Provider GET + internal history writes only. No chat send, read receipt,
 * booking edit, unread-state change, rental completion or payment operation. */
export const refresh = action({args:{thread_id:v.string(),force:v.optional(v.boolean())},handler:async(ctx,{thread_id,force}):Promise<{ok:boolean;cached?:boolean;error?:string}>=>{
 const context=await ctx.runQuery(internal.hygglo_history.context,{thread_id});
 if(!context)return {ok:false,error:"This conversation has no linked rental account."};
 const lease=crypto.randomUUID();
 if(!await ctx.runMutation(internal.hygglo_history.claim,{thread_id,account:context.account,lease,force}))return {ok:true,cached:true};
 try{
  const detail=await createHyggloCore(context.account).getOrder(thread_id);
  if(String(detail.id)!==thread_id||!Array.isArray(detail.activities))throw Error("Incomplete provider history");
  const entries=hyggloHistoryEntries(detail);
  const hash=Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(entries)))).toString("hex");
  if(context.state?.source_hash!==hash){
   for(let i=0;i<entries.length;i+=40)await ctx.runMutation(internal.hygglo_history.writePage,{thread_id,lease,entries:entries.slice(i,i+40)});
  }
  await ctx.runMutation(internal.hygglo_history.complete,{thread_id,lease,hash,proof:quickReplyProof(detail)});
  return {ok:true};
 }catch(error){
  const permanent=error instanceof HyggloApiError&&[400,401,403,404].includes(error.status) || error instanceof Error&&/not configured|missing credentials|credentials not found/i.test(error.message);
  await ctx.runMutation(internal.hygglo_history.failed,{thread_id,lease,permanent});
  return {ok:false,error:"Could not refresh the complete conversation. Please retry."};
 }
}});
