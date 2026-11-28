import { amendmentMoneyClaims } from "./renter_amendment_money";
import { directItemSelection, matchesQuotedDates, type AcceptedAdditionLine } from "./renter_addition_acceptance";

export type CompleteBasketOffer = {
  start_date: string;
  end_date: string;
  total_gbp: number;
  lines: Array<{product_id:number;name:string;quantity:number;total_gbp:number}>;
};

const sameMoney=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.round(a*100)===Math.round(b*100);

/** Acceptance is bound to one immediately preceding, complete Lab quote. */
export function acceptsCompleteBasketOffer(text:string, offer:CompleteBasketOffer):boolean {
  const message=text.replace(/[’‘]/g,"'").replace(/\s+/g," ").trim();
  if(!message || /\b(?:maybe|perhaps|might|thinking|not yet|don't|do not|no thanks|hold off|wait|unless|only if|instead|alternatively|option|options|but)\b/i.test(message))return false;

  const bare=/^(?:yes|yep|yeah|okay|ok|sure|perfect|great|sounds good|that works|works for me)[,!\s]*(?:please)?[.!\s]*$/i.test(message);
  const affirmative=/^(?:(?:yes|yep|yeah|okay|ok|sure|perfect|great)[,\s]+)?(?:please\s+)?(?:go ahead|proceed|apply it|do that|that works|sounds good|update|change|set|make|put|add|book|confirm)\b/i.test(message)
    || /\b(?:go ahead|please\s+(?:update|change|set|make|put|add|book|apply|proceed)|i accept|that works for me|sounds good|looks good)\b/i.test(message);
  if(!bare&&!affirmative)return false;

  if(!matchesQuotedDates(message,offer))return false;
  const amounts=amendmentMoneyClaims(message);
  if(amounts.some(claim=>{
    const restatedTotal=claim.role==="total" || claim.role==="unlabelled" &&
      /\b(?:at|for)(?:\s+the)?(?:\s+quoted)?\s*$/i.test(claim.before) && !/\b(?:per|each|daily)\b|\/\s*day/i.test(claim.after);
    return !restatedTotal || !sameMoney(claim.amount,offer.total_gbp);
  }))return false;

  // If the renter restates item quantities, bind them to the quoted complete
  // basket. Generic agreement remains valid only because this is the sole
  // current owner offer and is checked again by the transaction boundary.
  const lines:AcceptedAdditionLine[]=offer.lines.map(line=>({product_id:line.product_id,name:line.name,qty:line.quantity,line_total_gbp:line.total_gbp}));
  const normalized=message
    .replace(/\b(?:update|change|set|make|put)\s+(?:(?:the\s+)?(?:booking|basket|order|request)|it)\s+(?:to|as)\b/i,"please add")
    .replace(/\b(?:for|from)\s+(?:\d{1,2}(?:st|nd|rd|th)?\s+)?(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|\d{4}-\d{2}-\d{2}).*$/i,"");
  const itemSelection=directItemSelection(normalized,lines,"addition");
  if(itemSelection.named&&!itemSelection.matches)return false;
  return true;
}
