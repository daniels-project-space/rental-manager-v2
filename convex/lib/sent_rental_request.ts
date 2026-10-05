import {inquiryOffersForText} from "./native_inquiry_offer";
import type {QueryCtx,MutationCtx} from "../_generated/server";
import type {Doc} from "../_generated/dataModel";
import {recentThreadMessages} from "./thread_messages";
import {currentDraftApproval,draftContextKey} from "./draft_review";
import {getBotBooking,getLabOrder} from "./renter_booking";
import {sameRentalRequest,type RentalRequest} from "./rental_request";

/** Inquiry roots must be actual renter messages in this thread. Previously
 * served roots remain selectable through indexed history, even after scrolling. */
export async function validateRentalRequest(ctx:QueryCtx,thread:string,request:RentalRequest,latestMessageId?:string){
 if(request.kind==="primary")return request;
 const origin=await ctx.db.query("hygglo_messages").withIndex("by_thread_and_message",q=>q.eq("thread_id",thread).eq("message_id",request.origin_message_id)).first();
 if(!origin||origin.sender!=="renter"||origin.message_id!==latestMessageId&&(!origin.rental_request||!sameRentalRequest(origin.rental_request,request)))throw new Error("Rental request origin is not a current or previously served renter request in this thread");
 return request;
}

/** Called in the owner-message transaction while its approved draft still
 * exists. Exact replies and valid edits around Native blocks retain lineage. */
export async function recordSentRentalRequest(ctx:MutationCtx,conversation:Doc<"conversations">|null,text:string):Promise<RentalRequest|undefined>{
 const request=conversation?.ai_draft_evidence?.rental_request;
 if(!conversation||!request||!conversation.ai_draft_text)return;
 const selection=inquiryOffersForText(conversation.ai_draft_evidence,conversation.ai_draft_text,text);
 if(selection.supported?!selection.ok:text.trim()!==conversation.ai_draft_text.trim())return;
 const [latest]=await recentThreadMessages(ctx,conversation.thread_id,1);
 if(latest?.sender!=="renter")return;
 const settings=await ctx.db.query("settings").first();
 const context_key=draftContextKey(await getBotBooking(ctx,conversation.thread_id),conversation.inquiry_items,await getLabOrder(ctx,conversation.thread_id));
 if(!currentDraftApproval(conversation,{message_id:latest.message_id,context_key,epoch:settings?.draft_epoch??0}))return;
 const valid=await validateRentalRequest(ctx,conversation.thread_id,request,latest.message_id);
 await ctx.db.patch(latest._id,{rental_request:valid});
 await ctx.db.patch(conversation._id,{active_rental_request:valid});
 return valid;
}
