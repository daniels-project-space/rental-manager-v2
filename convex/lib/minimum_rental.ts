import { inclusiveRentalDays } from "./hygglo_pricing";
import { samePriceNames, type PriceEvidence } from "./price_claims";
import type { StockRequest } from "./stock_claims";
export type MinimumRentalContext = {
  stage: string; threshold_gbp: number; total_gbp: number | null;
  status: "below" | "meets" | "unknown" | "not_applicable" | "disabled";
  basis: "current_booking" | "complete_requested_quote" | "none";
};
/** Complete exact-request arithmetic; alternatives and partial prices are not a basket. */
export function completeRentalTotal(prices:PriceEvidence[],request:StockRequest): {total:number;basis:"current_booking"|"complete_requested_quote"}|null {
  const days=inclusiveRentalDays(request.start_date,request.end_date);
  if(days==null || !request.items.length)return null;
  const positive=(n:unknown):n is number=>typeof n==="number" && Number.isFinite(n) && n>0;
  const scope=(e:PriceEvidence)=>!!e.call_id && !!e.source && e.days===days && (!e.start_date||e.start_date===request.start_date) && (!e.end_date||e.end_date===request.end_date);
  const baskets=prices.filter(e=>e.kind==="basket" && e.source!=="complete_requested_quote" && scope(e) && positive(e.total_gbp) && e.items?.length===request.items.length &&
    request.items.every(i=>e.items!.some(c=>samePriceNames([c.name],[i.name,...(i.aliases??[])])&&c.quantity===i.quantity)));
  const booking=baskets.find(e=>e.source==="booking_gross_amount") ?? baskets.at(-1);
  if(booking?.total_gbp!=null)return {total:booking.total_gbp,basis:"current_booking"};
  const parts=request.items.map(i=>{
    const quotes=prices.filter(e=>e.kind==="rental" && scope(e) && e.quantity===i.quantity && positive(e.total_gbp) && samePriceNames(e.names,[i.name,...(i.aliases??[])]));
    const values=[...new Set(quotes.map(e=>e.total_gbp!))];
    return values.length===1?values[0]:null;
  });
  if(parts.some(n=>n==null))return null;
  return {total:Math.round(parts.reduce<number>((sum,n)=>sum+n!,0)*100)/100,basis:"complete_requested_quote"};
}
export function requestedBasketEvidence(prices:PriceEvidence[],request:StockRequest):PriceEvidence[] {
  const total=completeRentalTotal(prices,request);
  if(!total || total.basis!=="complete_requested_quote")return [];
  return [{names:[],items:request.items.map(i=>({name:i.name,quantity:i.quantity})),kind:"basket",days:inclusiveRentalDays(request.start_date,request.end_date)!,
    start_date:request.start_date!,end_date:request.end_date!,total_gbp:total.total,call_id:"server:requested-basket",source:"complete_requested_quote"}];
}
/** Commercial policy applies before owner acceptance, never retroactively. */
export function minimumRentalContext(stage: string, threshold: number, prices: PriceEvidence[], request: StockRequest): MinimumRentalContext {
  const min = Number.isFinite(threshold) && threshold >= 0 ? threshold : 40;
  const context: MinimumRentalContext={stage,threshold_gbp:min,total_gbp:null,status:"unknown",basis:"none"};
  if(min===0)return {...context,status:"disabled"};
  if(!["INQUIRY","AWAITING_OWNER_APPROVAL"].includes(stage))return {...context,status:"not_applicable"};
  const total=completeRentalTotal(prices,request);
  if(!total)return context;
  return {...context,total_gbp:total.total,basis:total.basis,status:total.total<min?"below":"meets"};
}
export function minimumRentalPrompt(context:MinimumRentalContext) {
  if(context.status==="below")return `COMMERCIAL CONTEXT (private): the complete exact-date basket quote is £${context.total_gbp}. Before owner acceptance, naturally suggest one relevant optional item that we own, using actual dated stock, compatibility and price evidence. Never charge included gear twice. If extras are declined, do not invent a surcharge or altered price; discuss a verified longer hire only if their dates are flexible, otherwise leave any price adjustment to the owner. Never disclose an internal threshold, minimum-rental policy, revenue or earnings. This does not establish availability or approval.`;
  if(context.status==="unknown")return "COMMERCIAL CONTEXT: no complete exact-date basket total is established. Do not classify this as a small booking from a one-day rate, a partial basket or alternative options. Establish missing dates, quantity and exact quotes before applying the commercial nudge.";
  if(context.status==="not_applicable")return "COMMERCIAL CONTEXT: this existing order is beyond the prospective quotation/owner-approval stage. Preserve the agreed booking price; help with the current stage and question. Do not push a new minimum, compulsory extras or a longer hire to raise its original value. Quote requested additions or extensions separately using current evidence.";
  return "COMMERCIAL CONTEXT: no minimum-value nudge is required. Answer the current question using verified facts.";
}
