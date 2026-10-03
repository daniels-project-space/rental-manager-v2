import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

type RenterLink = { renter_id?: Id<"renters">; hygglo_user_id?: string };
/** Display names are presentation, never identity. Resolve trust/history from
 * Native links or an exact platform user ID; contradictory links need review. */
export async function resolveBotRenter(ctx:QueryCtx,booking:RenterLink|null,conversation:RenterLink|null) {
  const links=[...new Set([booking?.renter_id,conversation?.renter_id].filter((id):id is Id<"renters">=>!!id))];
  const conflict=()=>({renter:null,identity_conflict:true} as const);
  if(links.length>1)return conflict();
  const linked=links.length?await ctx.db.get(links[0]):null;
  const userId=booking?.hygglo_user_id?.trim();
  if(!userId)return {renter:linked,identity_conflict:false} as const;
  if(linked?.hygglo_user_id && linked.hygglo_user_id!==userId)return conflict();
  const matches=await ctx.db.query("renters").withIndex("by_hygglo_user_id",q=>q.eq("hygglo_user_id",userId)).take(2);
  if(matches.length>1||linked&&matches.length===1&&matches[0]._id!==linked._id)return conflict();
  return {renter:linked??matches[0]??null,identity_conflict:false} as const;
}

export async function getBotRenter(ctx:QueryCtx,booking:RenterLink|null,conversation:RenterLink|null):Promise<Doc<"renters">|null> {
  const result=await resolveBotRenter(ctx,booking,conversation);
  if(result.identity_conflict)throw new ConvexError({code:"RENTER_IDENTITY_CONFLICT",message:"Renter identity needs owner review before drafting."});
  return result.renter;
}
