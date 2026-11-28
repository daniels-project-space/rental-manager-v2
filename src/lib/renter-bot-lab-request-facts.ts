type Item={name?:unknown;qty?:unknown;daily_price_gbp?:unknown};
type Context={items?:unknown;start_date?:unknown;end_date?:unknown;pickup_time?:unknown;return_time?:unknown;gross_paid_gbp?:unknown;stage?:unknown};

/** The test chat starts with the rental itself, not the answers to questions
 * the real bot should retrieve. Keep this projection on an explicit whitelist. */
export function renterBotLabRequestFacts(context:Context,accountSlug:string,currentTotalGbp?:number|null) {
  const items=Array.isArray(context.items)?context.items.flatMap((raw)=>{
    if(!raw||typeof raw!=="object"||Array.isArray(raw))return [];
    const item=raw as Item;
    if(typeof item.name!=="string"||!item.name.trim())return [];
    return [{name:item.name,quantity:Number.isSafeInteger(item.qty)&&Number(item.qty)>0?Number(item.qty):1,
      ...(typeof item.daily_price_gbp==="number"&&Number.isFinite(item.daily_price_gbp)?{current_daily_price_gbp:item.daily_price_gbp}:{})}];
  }):[];
  const total=typeof currentTotalGbp==="number"&&Number.isFinite(currentTotalGbp)
    ? currentTotalGbp : typeof context.gross_paid_gbp==="number"&&Number.isFinite(context.gross_paid_gbp)
      ? context.gross_paid_gbp : null;
  return `LAB RENTAL FACTS: ${JSON.stringify({account:accountSlug,stage:typeof context.stage==="string"?context.stage:null,items,start_date:context.start_date??null,end_date:context.end_date??null,
    pickup_time:context.pickup_time??"not confirmed",return_time:context.return_time??"not confirmed",current_total_gbp:total})}. These request facts are already loaded; do not ask the renter to repeat them. This is the only rental-specific context preloaded into the model. For kit contents, technical specifications, availability, listing-specific pickup conditions, or seller-description details, call get_listing_context. For account pickup area, opening windows, and any permitted exact meeting point, call get_pickup_context. If the renter mentions, disputes, or asks why a location named in the listing differs from the handoff area, call BOTH get_listing_context and get_pickup_context before answering, even if one fact seems known: verify the listing's location from the listing tool and the selected account's handoff area from the pickup tool. Use an item-specific reason only if the listing tool returns a current owner-verified reason; otherwise state the true handoff boundary without inventing a repair, rental, or other temporary excuse. Use dated basket/price tools for availability, changed items or dates, add-ons, delivery, and new quotes; use the correct change tool only after clear renter consent. A question about an option or price is not consent to change the basket. Present each opening window as a continuous range (for example, “10am to 12pm”), never as comma-separated endpoints. Keep a combined logistics reply under 300 characters while answering each explicit question. Do not expose internal labels or an exact address withheld by the tool.`;
}
