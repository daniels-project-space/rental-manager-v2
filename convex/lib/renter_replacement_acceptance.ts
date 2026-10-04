import {lensClaimReferences} from "./lens_claim_references";
import {samePriceNames} from "./price_claims";
import {explicitRecommendationUse} from "./recommendation_basket";
import {directItemSelection,matchesQuotedDates,type AcceptedAdditionLine} from "./renter_addition_acceptance";
import {amendmentMoneyClaims} from "./renter_amendment_money";
import {renterItemNames} from "./renter_item_names";
import {tokenize} from "./item_name_match";
import type {SentReplacementProposal} from "./renter_replacement_proposal";
export type ReplacementAcceptanceQuote={context_key:string;epoch:number;physical_identity_key:string;base_physical_identity_key:string;start_date:string;end_date:string;total_gbp:number;base_total_gbp:number;added:AcceptedAdditionLine[];removed:AcceptedAdditionLine[]};
const sameMoney=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.round(a*100)===Math.round(b*100);
const keys=(lines:Array<{product_id:number;qty:number}>)=>JSON.stringify(lines.map(i=>({product_id:i.product_id,qty:i.qty})).sort((a,b)=>a.product_id-b.product_id));
const named=(text:string,line:AcceptedAdditionLine,all:AcceptedAdditionLine[])=>{
 const words=tokenize(text);
 const entries=all.map(l=>({line:l,names:[l.identity_name??l.name,...renterItemNames(l.identity_name??l.name),...(l.aliases??[])]}));
 const references=lensClaimReferences(entries,samePriceNames);
 const normalized=text.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
 if([...references].some(([reference,entry])=>entry.line===line&&` ${normalized} `.includes(` ${reference} `)))return true;
 return [line.identity_name??line.name,...renterItemNames(line.identity_name??line.name),...(line.aliases??[]),...(line.primary_removal_aliases??[])].some(n=>{const tokens=tokenize(n);return tokens.size>1&&[...tokens].every(t=>words.has(t));});
};
export function isReplacementReference(message:string){
 return /^(?:(?:yes|yep|yeah|okay|ok|sure|perfect)[,\s!]+)?(?:please\s+)?(?:go ahead(?: and (?:make|do) (?:the|that) (?:swap|replacement))?|(?:make|do) (?:the|that) (?:swap|replacement))[.!\s]*(?:thanks|thank you)?[.!\s]*$/i.test(message)||/^(?:yes|yep|yeah|okay|ok|sure)[,!\s]*(?:please)?[.!\s]*$/i.test(message);
}
/** Prevent splitting the same inbound swap into independent destructive steps. */
export function requiresReplacementTransaction(text:string,owner?:{quoted_replacements?:SentReplacementProposal[]}){
 return explicitRecommendationUse(text)==="replacement" || !!owner?.quoted_replacements?.length && isReplacementReference(text.trim());
}
/** Only a reconciled directional instruction or acceptance of one actually
 * transmitted, unchanged Native replacement quote permits the transaction. */
export function acceptsReplacement(text:string,q:ReplacementAcceptanceQuote,owner?:{body_text:string;quoted_replacements?:SentReplacementProposal[]}){
 const message=text.replace(/[’‘]/g,"'").replace(/```[\s\S]*?```/g," ").replace(/["“][^"”]*["”]/g," ").replace(/\s+/g," ").trim();
 if(!message||/\b(?:if|unless|maybe|might|consider|thinking|suppose|example|said|says|told|after|when|later|wait|hold off|not|don't|do not|without)\b/i.test(message)||!matchesQuotedDates(message,q))return false;
 const money=amendmentMoneyClaims(message);
 const total=money.filter(m=>m.role==="total"||money.length===1&&m.role==="unlabelled");
 // Delta explanations do not replace consent to the full Native total.
 if(money.some(m=>{
  const expected=m.role==="base"?q.base_total_gbp:m.role==="increase"?q.total_gbp-q.base_total_gbp
   :m.role==="reduction"?q.base_total_gbp-q.total_gbp:total.includes(m)?q.total_gbp:NaN;
  return !Number.isFinite(expected)||expected<0||!sameMoney(m.amount,expected);
 }))return false;
 const swap=/^(?:(?:yes|yep|okay|ok|sure|please)[,\s]+|(?:go ahead(?: and)?|(?:can|could|would) you|(?:I|we)(?:'d| would) like (?:you )?to|(?:I|we) want (?:you )?to)\s+)*(?:swap|replace)\s+(.+?)\s+(?:with|for)\s+(.+)$/i.exec(message);
 if(swap){
  const old=directItemSelection(`remove ${swap[1]}`,q.removed,"removal");
  const firstAmount=amendmentMoneyClaims(swap[2])[0];
  const itemText=(firstAmount?swap[2].slice(0,firstAmount.index):swap[2]).replace(/\b(?:for|at)\s*$/i,"").replace(/\(\s*$/,"").trim();
  const added=directItemSelection(`add ${itemText}`,q.added);
  if(!old.matches||!added.matches)return false;
  if(total.length)return true;
 }
 if(!owner)return false;
 const offers=owner.quoted_replacements??[];
 const candidate=offers.filter(p=>p.context_key===q.context_key&&p.epoch===q.epoch&&p.physical_identity_key===q.physical_identity_key&&p.base_physical_identity_key===q.base_physical_identity_key&&p.start_date===q.start_date&&p.end_date===q.end_date&&keys(p.items)===keys(q.added)&&keys(p.removed_listings)===keys(q.removed)&&sameMoney(p.total_gbp,q.total_gbp)&&sameMoney(p.base_total_gbp,q.base_total_gbp));
 const ownerTotals=amendmentMoneyClaims(owner.body_text).filter(m=>m.role==="total"&&sameMoney(m.amount,q.total_gbp));
 if(candidate.length!==1||offers.length!==1||!ownerTotals.length||!matchesQuotedDates(owner.body_text,q)||!/\b(?:swap|replace|replacement)\b/i.test(owner.body_text)||/\b(?:or|alternatively|either|options?)\b/i.test(owner.body_text)||![...q.added,...q.removed].every(l=>named(owner.body_text,l,[...q.added,...q.removed])))return false;
 if(swap)return true;
 return isReplacementReference(message);
}
