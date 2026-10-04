import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { getBotBooking, getLabOrder } from "./renter_booking";
import { recentThreadMessages } from "./thread_messages";
import { friendReferralCode } from "./verification_failure";
import { resolveOrderPhysicalItems, sameOrderPhysicalItems } from "./renter_order_stock";
import { rentalStage } from "./rental_stage";
import { londonToday } from "./effectiveDates";
import { shortItemName } from "./item_display_name";

/** Share equipment references, never the source renter's profile, transcript,
 * approval or payment. The destination's own request remains authoritative. */
export async function referralContext(ctx:QueryCtx,thread:string,account:string,inventory?:Doc<"items">[]) {
 if(!thread.startsWith("__probe__"))return null;
 const messages=await recentThreadMessages(ctx,thread,12);
 const {code,ambiguous}=friendReferralCode(messages);
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
 return {ok:true,code,already_linked:false,source_start_date:source.start_date??null,source_end_date:source.end_date??null,
  items:[...requested.values()],physical_items:[...physical.items],
  guidance:"Shared equipment reference only. No basket has been applied, no booking created, and approval/payment/verification never transfer. Respect the friend's CURRENT message for dates, quantities and intent. For a quote use these exact listing IDs with check_basket_availability, the requested dates/quantities and standalone use. Original dates/quantities are defaults only when the friend asks for the same terms without changes. Info or quote-only requests are read-only. For an explicit basket restoration use restore_referral_basket with exact terms. All real Hygglo writes still require separate written rollout consent."};
}
