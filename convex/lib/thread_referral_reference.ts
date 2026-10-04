import type {QueryCtx} from "../_generated/server";
import {friendReferralCodesFromMessage} from "./verification_failure";

export type ThreadReferralReference={codes:string[];message_id:string};
export function referralReferenceSelection(reference:ThreadReferralReference|null|undefined) {
 const codes=reference?.codes??[];
 return {code:codes.length===1?codes[0]:null,ambiguous:codes.length>1};
}

/** Equipment identity lasts beyond the agent transcript window. It grants no
 * consent, price, availability, verification or booking status. New ingestion
 * stores the last reference-bearing renter message, including ambiguity.
 * Legacy threads recover through the existing renter index, stopping at the
 * first reference-bearing message rather than collecting the transcript;
 * the next inbound stores that result, avoiding repeated transcript scans. */
export async function loadThreadReferralReference(ctx:QueryCtx,thread:string):Promise<ThreadReferralReference|null> {
 const conv=await ctx.db.query("conversations").withIndex("by_thread",q=>q.eq("thread_id",thread)).first();
 if(conv?.referral_reference)return conv.referral_reference;
 for await(const message of ctx.db.query("hygglo_messages").withIndex("by_thread_sender",q=>q.eq("thread_id",thread).eq("sender","renter")).order("desc")) {
  const codes=friendReferralCodesFromMessage(message.body_text);
  if(codes.length)return {codes,message_id:message.message_id};
 }
 return null;
}
