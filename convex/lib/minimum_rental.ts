import { inclusiveRentalDays } from "./hygglo_pricing";
import { samePriceNames, type PriceEvidence } from "./price_claims";
import type { StockRequest } from "./stock_claims";
export type MinimumRentalContext = {
  stage: string; threshold_gbp: number; total_gbp: number | null;
  status: "below" | "meets" | "unknown" | "not_applicable" | "disabled";
  basis: "current_booking" | "complete_requested_quote" | "lowest_selected_inquiry_quote" | "none";
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
export function minimumRentalContext(stage: string, threshold: number, prices: PriceEvidence[], request: StockRequest, selectedInquiryQuotes: PriceEvidence[] = []): MinimumRentalContext {
  const min = Number.isFinite(threshold) && threshold >= 0 ? threshold : 40;
  const context: MinimumRentalContext={stage,threshold_gbp:min,total_gbp:null,status:"unknown",basis:"none"};
  if(min===0)return {...context,status:"disabled"};
  if(!["INQUIRY","AWAITING_OWNER_APPROVAL"].includes(stage))return {...context,status:"not_applicable"};
  // Selected, server-rendered alternatives are separate prospective rentals.
  // Any below-threshold option warrants the optional nudge; never sum them or
  // let an earlier request/expensive alternative hide the cheaper offer.
  if(stage==="INQUIRY" && selectedInquiryQuotes.length){
    const totals=selectedInquiryQuotes.map(q=>q.source==="native_inquiry_basket" && q.kind==="basket" && q.quote_role==="inquiry"
      ?completeRentalTotal([q],{start_date:q.start_date,end_date:q.end_date,items:q.items??[]})?.total:null);
    if(totals.some(n=>n==null))return context;
    const total=Math.min(...totals as number[]);
    return {...context,total_gbp:total,basis:"lowest_selected_inquiry_quote",status:total<min?"below":"meets"};
  }
  const total=completeRentalTotal(prices,request);
  if(!total)return context;
  return {...context,total_gbp:total.total,basis:total.basis,status:total.total<min?"below":"meets"};
}
export function minimumRentalPrompt(context:MinimumRentalContext) {
  if(context.status==="below")return `COMMERCIAL CONTEXT (private): ${context.basis==="lowest_selected_inquiry_quote"?"the lowest separately offered exact-date quote":"the complete exact-date basket quote"} is £${context.total_gbp}. Answer the renter's question, then include one short optional suggestion before inviting them to proceed. Use an owned item with verified compatibility, exact-date stock and current-duration price; never charge included gear twice. If the shoot is unspecified, describe the item's actual use conditionally (for example, a verified wider lens only if they need a wider view); do not invent their needs. If no suitable extra has verified evidence, check it with the tools or ask what they are shooting instead of inventing an offer. This is optional: never make extras a condition of renting or imply they have been added. If extras are declined, do not invent a surcharge or altered price; discuss a verified longer hire only if their dates are flexible, otherwise leave any price adjustment to the owner. Never disclose an internal threshold, minimum-rental policy, revenue or earnings. This does not establish availability or approval.`;
  if(context.status==="unknown")return "COMMERCIAL CONTEXT: no complete exact-date basket total is established. Do not classify this as a small booking from a one-day rate, a partial basket or alternative options. Establish missing dates, quantity and exact quotes before applying the commercial nudge.";
  if(context.status==="not_applicable")return "COMMERCIAL CONTEXT: this existing order is beyond the prospective quotation/owner-approval stage. Preserve the agreed booking price; help with the current stage and question. Do not push a new minimum, compulsory extras or a longer hire to raise its original value. Quote requested additions or extensions separately using current evidence.";
  return "COMMERCIAL CONTEXT: no minimum-value nudge is required. Answer the current question using verified facts.";
}
