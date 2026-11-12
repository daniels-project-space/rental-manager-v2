import {v,type Infer} from "convex/values";
import type {PriceEvidence} from "./price_claims";
import {amendmentMoneyClaims} from "./renter_amendment_money";
import {renterItemNames} from "./renter_item_names";
const member=v.object({name:v.string(),quantity:v.number()});
const selection=v.object({product_id:v.number(),qty:v.number()});
export const sentReplacementProposalValidator=v.object({
 context_key:v.string(),epoch:v.number(),quoted_for_message_id:v.string(),
 physical_identity_key:v.string(),base_physical_identity_key:v.string(),
 items:v.array(selection),removed_listings:v.array(selection),
 base_items:v.array(member),added_items:v.array(member),removed_items:v.array(member),
 start_date:v.string(),end_date:v.string(),total_gbp:v.number(),base_total_gbp:v.number(),
});
export type SentReplacementProposal=Infer<typeof sentReplacementProposalValidator>;
/** Native immutable selections only; recording a quote never records consent. */
export function replacementProposalsFromEvidence(prices:PriceEvidence[],scope:{context_key:string;epoch:number;message_id:string}){
 const out=new Map<string,SentReplacementProposal>();
 for(const e of prices){const p=e.proposal;
  const valid=(a:Array<{product_id:number;quantity:number}>|undefined)=>a?.length&&a.length<=8&&a.every(i=>Number.isInteger(i.product_id)&&i.product_id>0&&Number.isInteger(i.quantity)&&i.quantity>0&&i.quantity<=20)&&new Set(a.map(i=>i.product_id)).size===a.length;
  if(e.source!=="native_lab_proposal"||e.kind!=="basket"||e.quote_role||!p?.removed_items?.length||!valid(p.added_listings)||!valid(p.removed_listings)||!p.physical_identity_key||!p.base_physical_identity_key||!e.start_date||!e.end_date||!Number.isFinite(e.total_gbp)||(e.total_gbp??0)<=0||!Number.isFinite(p.base_total_gbp)||(p.base_total_gbp??0)<=0)continue;
  const convert=(a:NonNullable<typeof p.added_listings>)=>a.map(i=>({product_id:i.product_id,qty:i.quantity})).sort((a,b)=>a.product_id-b.product_id);
  const record:SentReplacementProposal={context_key:scope.context_key,epoch:scope.epoch,quoted_for_message_id:scope.message_id,items:convert(p.added_listings!),removed_listings:convert(p.removed_listings!),physical_identity_key:p.physical_identity_key,base_physical_identity_key:p.base_physical_identity_key,base_items:p.base_items,added_items:p.added_items,removed_items:p.removed_items,start_date:e.start_date,end_date:e.end_date,total_gbp:e.total_gbp!,base_total_gbp:p.base_total_gbp!};
  out.set(JSON.stringify(record),record);
 }
 return [...out.values()];
}

/** Make the removed listing explicit when a single Native swap offer names
 * only the replacement. The recorded quote remains the source of identity,
 * price and scope; a different or ambiguous offer is never rewritten. */
export function discloseReplacementSource(text:string,prices:PriceEvidence[]):string {
 if(!/\b(?:swap|swapping|replace|replacing|switch|switching)\b/i.test(text) ||
    !/\b(?:would|could|if|like|shall)\b/i.test(text))return text;
 const candidates=replacementProposalsFromEvidence(prices,{context_key:"local",epoch:0,message_id:"local"});
 if(candidates.length!==1)return text;
 const proposal=candidates[0],money=amendmentMoneyClaims(text);
 if(!money.some(m=>m.role==="total" && Math.round(m.amount*100)===Math.round(proposal.total_gbp*100)) ||
    money.some(m=>m.role==="unsupported" || m.role==="total" && Math.round(m.amount*100)!==Math.round(proposal.total_gbp*100)))return text;
 const normalized=` ${text.toLowerCase().replace(/[^a-z0-9]+/g," ").trim()} `;
 const named=(name:string)=>renterItemNames(name).some(alias=>{
  const value=alias.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  return value.length>2 && normalized.includes(` ${value} `);
 });
 if(!proposal.added_items.every(i=>named(i.name)) || proposal.removed_items.every(i=>named(i.name)))return text;
 const removed=proposal.removed_items.map(i=>`${i.quantity} × ${i.name}`).join(", ");
 const addition=`This would replace ${removed} in your current request.`;
 const beforeQuestion=/\s*(?=let me know\b|would you like\b|shall i\b)/i.exec(text);
 return beforeQuestion && beforeQuestion.index>0
  ? `${text.slice(0,beforeQuestion.index).trimEnd()} ${addition} ${text.slice(beforeQuestion.index).trimStart()}`
  : `${text.trimEnd()} ${addition}`;
}
