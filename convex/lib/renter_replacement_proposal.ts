import {v,type Infer} from "convex/values";
import type {PriceEvidence} from "./price_claims";
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
