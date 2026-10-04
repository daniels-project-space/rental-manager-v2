import type { RecommendationRequirement } from "./recommendation_qualification";
/** This Native question identifies the proposed action, not renter consent. */
export const REFERRAL_RESTORE_OFFER="Would you like me to add this quoted gear to your rental request for these dates? You'll still need to complete your own booking checks.";
export function previousReferralOffer(messages:Array<{sender?:string;quoted_additions?:Array<{referral_code?:string;recommendation_requirements?:RecommendationRequirement[];start_date:string;end_date:string;items:Array<{product_id:number;qty:number}>;context_key:string}>}>) {
 const previous=messages.at(-2);
 if(previous?.sender!=="owner")return null;
 const offers=(previous.quoted_additions??[]).filter(p=>p.referral_code);
 return offers.length===1?offers[0]:null;
}
