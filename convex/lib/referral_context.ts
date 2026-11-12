import { previousReferralOffer, renterAcceptsReferralOffer } from "./referral_offer";
import { draftContextKey } from "./draft_review";
import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { getBotBooking, getLabOrder } from "./renter_booking";
import { recentThreadMessages } from "./thread_messages";
import { loadThreadReferralReference,referralReferenceSelection } from "./thread_referral_reference";
import { resolveOrderPhysicalItems, sameOrderPhysicalItems } from "./renter_order_stock";
import { rentalStage } from "./rental_stage";
import { londonToday } from "./effectiveDates";
import { shortItemName } from "./item_display_name";
import { requestsFriendBasketRestore } from "./verification_failure";

/** Share equipment references, never the source renter's profile, transcript,
 * approval or payment. The destination's own request remains authoritative. */
export async function referralContext(ctx:QueryCtx,thread:string,account:string,inventory?:Doc<"items">[]) {
 if(!thread.startsWith("__probe__"))return null;
 const messages=await recentThreadMessages(ctx,thread,12);
 const supplied=referralReferenceSelection(await loadThreadReferralReference(ctx,thread)),pending=previousReferralOffer(messages);
 const code=supplied.code??(!supplied.ambiguous?pending?.referral_code:undefined),ambiguous=supplied.ambiguous;
 if(!code)return ambiguous?{ok:false,error:"Multiple basket references need an explicit choice"}:null;
 const ref=await ctx.db.query("renter_bot_lab_referrals").withIndex("by_code",q=>q.eq("code",code)).unique();
 if(!ref||ref.expires_at<=Date.now()||ref.account_slug!==account||ref.source_thread_id===thread)
  return {ok:false,code,error:"The referral is invalid, expired or belongs to a different rental account"};
 if(ref.redeemed_by)return ref.redeemed_by===thread?{ok:true,code,already_linked:true,guidance:"The referral is already linked. Use the destination's CURRENT basket and rental stage; do not rebuild from the failed source or imply outstanding checks without current stage evidence."}:{ok:false,code,error:"This referral has already been used"};
 const source=await getLabOrder(ctx,ref.source_thread_id);
 if(!source||rentalStage(await getBotBooking(ctx,ref.source_thread_id),londonToday()).stage!=="VERIFICATION_FAILED")
  return {ok:false,code,error:"The referral no longer belongs to a cancelled verification failure"};
 const physical=await resolveOrderPhysicalItems(ctx,account,source.items,inventory);
 if(!sameOrderPhysicalItems(ref.physical_items,[...physical.items]))return {ok:false,code,error:"Original equipment identity needs owner review"};
 const requested=new Map<number,{product_id:number;name:string;quantity:number}>();
 for(const line of source.items){
  if(line.product_id==null)return {ok:false,code,error:"Original equipment needs an exact current listing reference"};
  const previous=requested.get(line.product_id);
  requested.set(line.product_id,{product_id:line.product_id,name:shortItemName(line.name),quantity:(previous?.quantity??0)+line.qty});
 }
 const pending_offer=pending?.referral_code===code && pending.context_key===draftContextKey(await getBotBooking(ctx,thread),(await ctx.db.query("conversations").withIndex("by_thread",q=>q.eq("thread_id",thread)).first())?.inquiry_items,await getLabOrder(ctx,thread))?pending:null;
 return {ok:true,code,already_linked:false,source_start_date:source.start_date??null,source_end_date:source.end_date??null,
  items:[...requested.values()],physical_items:[...physical.items],
  pending_offer,renter_accepts_sent_terms:renterAcceptsReferralOffer(pending_offer,messages),
  renter_requests_restoration:messages.at(-1)?.sender==="renter" && requestsFriendBasketRestore(messages.at(-1)?.body_text??""),
  guidance:"Shared equipment reference only. No basket has been applied, no booking created, and approval/payment/verification never transfer. If renter_requests_restoration=true, call restore_referral_basket for the current request instead of repeating the quote. If renter_accepts_sent_terms=true, call it with pending_offer's exact terms. That tool rechecks current stock, prices and qualifications; only its successful action receipt proves restoration. Respect current dates, quantities and exclusions; source terms are defaults only. For an availability question about the referred gear, check the exact basket once, state the verified current total from that check, and ask whether they want it added to their own request; a question or quote alone is read-only. All real Hygglo writes still require separate written rollout consent."};
}
