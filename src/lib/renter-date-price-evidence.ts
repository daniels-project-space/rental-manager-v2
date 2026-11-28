import type { PriceEvidence } from "../../convex/lib/price_claims";
import { inclusiveRentalDays, rentalQuote, type PriceTier } from "../../convex/lib/hygglo_pricing";
import type { ToolReceipt } from "./renter-tool-evidence";
type Line={name:string;qty:number;product_id?:number;item_id?:string;daily_price_gbp:number;effective_rate_gbp:number;line_total_gbp:number;price_tiers?:PriceTier[]};
type Quote={start_date:string;end_date:string;days:number;total_gbp:number;subtotal_gbp?:number;travel_compensation_gbp?:number;lines:Line[]};
const positive=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n)&&n>0;
const cents=(n:number)=>Math.round(n*100);
function validQuote(value:unknown):value is Quote {
 if(!value||typeof value!=="object")return false;const q=value as Quote;
 if(!Array.isArray(q.lines)||!q.lines.length)return false;
 const lineSubtotal=q.lines?.reduce((sum,l)=>sum+l.line_total_gbp,0);
 const subtotal=q.subtotal_gbp??lineSubtotal;
 const travelCompensation=q.travel_compensation_gbp??0;
 return typeof q.start_date==="string"&&typeof q.end_date==="string"&&inclusiveRentalDays(q.start_date,q.end_date)===q.days&&positive(q.total_gbp)
  &&Array.isArray(q.lines)&&!!q.lines.length&&q.lines.every(l=>l&&typeof l.name==="string"&&!!l.name.trim()&&positive(l.qty)&&Number.isInteger(l.qty)
   &&(typeof l.item_id==="string"&&!!l.item_id || positive(l.product_id)&&Number.isInteger(l.product_id))&&positive(l.daily_price_gbp)&&positive(l.effective_rate_gbp)&&positive(l.line_total_gbp)
   &&rentalQuote(l.price_tiers,l.daily_price_gbp,q.days,l.qty)?.listed_total_gbp===l.line_total_gbp && rentalQuote(l.price_tiers,l.daily_price_gbp,q.days,l.qty)?.daily_rate_gbp===l.effective_rate_gbp)
   &&(q.subtotal_gbp===undefined||positive(q.subtotal_gbp))&&typeof travelCompensation==="number"&&Number.isFinite(travelCompensation)&&travelCompensation>=0
   &&cents(lineSubtotal)===cents(subtotal)&&cents(subtotal-travelCompensation)===cents(q.total_gbp);
}
/** A Native date quote reprices exactly the existing basket, never a model's amount or basket. */
export function datePriceEvidence(receipt:ToolReceipt,threadId?:string):PriceEvidence[]{
 const r=receipt.result,q=r.quote,base=r.base_quote;
 if(receipt.tool!=="quote_booking_dates"||!receipt.call_id?.trim()||!threadId||r.thread_id!==threadId||r.ok!==true||r.preview_only!==true||r.source!=="native_lab_date_proposal"
  ||typeof r.before_context_key!=="string"||!r.before_context_key||!validQuote(q)||!validQuote(base)||q.lines.length!==base.lines.length)return [];
 const same=q.lines.every((l,i)=>{const old=base.lines[i];return l.name===old.name&&l.qty===old.qty&&l.product_id===old.product_id&&l.item_id===old.item_id&&l.daily_price_gbp===old.daily_price_gbp&&JSON.stringify(l.price_tiers??[])===JSON.stringify(old.price_tiers??[]);});
 if(!same||typeof r.price_delta_gbp!=="number"||!Number.isFinite(r.price_delta_gbp)||cents(r.price_delta_gbp)!==cents(q.total_gbp-base.total_gbp))return [];
 return [{names:[],kind:"basket",items:q.lines.map(l=>({name:l.name,quantity:l.qty})),total_gbp:q.total_gbp,days:q.days,start_date:q.start_date,end_date:q.end_date,
  date_proposal:{before_context_key:r.before_context_key,from_start_date:base.start_date,from_end_date:base.end_date,base_total_gbp:base.total_gbp,
   ...(typeof base.travel_compensation_gbp==="number"&&base.travel_compensation_gbp>0?{base_travel_compensation_gbp:base.travel_compensation_gbp}:{}),
   ...(typeof q.travel_compensation_gbp==="number"&&q.travel_compensation_gbp>0?{travel_compensation_gbp:q.travel_compensation_gbp}:{}),
   ...(typeof r.physical_identity_key==="string"&&r.physical_identity_key?{physical_identity_key:r.physical_identity_key}:{})},call_id:receipt.call_id,source:"native_lab_date_proposal"},
  ...q.lines.map(l=>({names:[l.name],kind:"rental" as const,quantity:l.qty,daily_rate_gbp:l.effective_rate_gbp,base_rate_gbp:l.daily_price_gbp,total_gbp:l.line_total_gbp,
   days:q.days,start_date:q.start_date,end_date:q.end_date,call_id:`${receipt.call_id}:line:${l.product_id??l.item_id}`,source:"native_lab_date_proposal"}))];
}
