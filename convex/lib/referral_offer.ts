import { acceptsAddition } from "./renter_addition_acceptance";
import type { SentAdditionProposal } from "./renter_sent_proposal";
/** This Native question identifies the proposed action, not renter consent. */
export const REFERRAL_RESTORE_OFFER="Would you like me to add this quoted gear to your rental request for these dates? You'll still need to complete your own booking checks.";
export function previousReferralOffer(messages:Array<{sender?:string;quoted_additions?:SentAdditionProposal[]}>) {
 const previous=messages.at(-2);
 if(previous?.sender!=="owner")return null;
 const offers=(previous.quoted_additions??[]).filter(p=>p.referral_code);
 return offers.length===1?offers[0]:null;
}
/** Planning evidence only: fresh stock, qualification and prices still belong
 * to the atomic tool. Reuse the same consent engine as that real transaction. */
export function renterAcceptsReferralOffer(offer:SentAdditionProposal|null,messages:Array<{sender?:string;body_text:string;quoted_additions?:SentAdditionProposal[]}>) {
 const current=messages.at(-1),owner=messages.at(-2);
 if(!offer?.referral_code || !offer.quoted_lines?.length || current?.sender!=="renter" || owner?.sender!=="owner")return false;
 return acceptsAddition(current.body_text,{context_key:offer.context_key,physical_identity_key:offer.physical_identity_key,
  start_date:offer.start_date,end_date:offer.end_date,total_gbp:offer.total_gbp,additional_cost_gbp:offer.additional_cost_gbp,
  lines:offer.quoted_lines},owner);
}
