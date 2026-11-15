import { replacementProposalsFromEvidence, type SentReplacementProposal } from "./renter_replacement_proposal";
import { renterItemNames } from "./renter_item_names";
import type { PriceEvidence } from "./price_claims";

/** Render only a narrow price-and-swap request from one exact Native quote.
 * Other questions remain with the ordinary agent and guard. The caller must
 * recheck the quote against current inventory before using this result. */
export function replacementQuoteFallback(input:{message:string;prices:PriceEvidence[];contextKey:string;epoch:number;messageId:string}):{proposal:SentReplacementProposal;text:string}|null {
 const message=input.message.trim();
 if(!/\b(?:swap|switch|replace)\b/i.test(message) || !/\b(?:cost|price|total|how much)\b/i.test(message) ||
  /\b(?:delivery|deliver|pickup|collection|location|address|postcode|discount|accessor(?:y|ies)|battery|batteries|card|charger|lens|mount|suitab\w*|compatib\w*|available|availability|instead of|or)\b/i.test(message) ||
  (message.match(/\?/g)?.length??0)>2)return null;
 const quotes=replacementProposalsFromEvidence(input.prices,{context_key:input.contextKey,epoch:input.epoch,message_id:input.messageId});
 const clean=(s:string)=>` ${s.toLowerCase().replace(/[^a-z0-9]+/g," ").trim()} `;
 const candidates=quotes.filter(q=>q.added_items.length===1 && q.removed_items.length===1 && q.added_items[0].quantity===1 && q.removed_items[0].quantity===1 &&
  renterItemNames(q.added_items[0].name).some(n=>n.length>3 && clean(message).includes(clean(n))));
 if(candidates.length!==1)return null;
 const proposal=candidates[0];
 if(proposal.items.length!==1 || proposal.removed_listings.length!==1 || !/^\d{4}-\d{2}-\d{2}$/.test(proposal.start_date) || !/^\d{4}-\d{2}-\d{2}$/.test(proposal.end_date))return null;
 const period=proposal.start_date===proposal.end_date ? "for the day" : `for ${proposal.start_date} to ${proposal.end_date}`;
 const total=Number(proposal.total_gbp.toFixed(2)).toString();
 return {proposal,text:`Swapping to the ${proposal.added_items[0].name} would bring the rental total to £${total} ${period}. This would replace 1 × ${proposal.removed_items[0].name} in your current request. Would you like me to make that change?`};
}
