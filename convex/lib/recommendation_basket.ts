export type RecommendationLine = { name: string; qty: number; item_id?: string; product_id?: number };
export type RecommendationUse = "standalone" | "additional" | "replacement";

/** Only unambiguous wording supplies an inferred stock scenario. This is not
 * permission to edit a booking; mixed/conditional wording still needs context. */
export function explicitRecommendationUse(message: string): Exclude<RecommendationUse,"standalone"> | undefined {
  const text=message.toLowerCase().replace(/[’‘]/g,"'");
  const additional=/\b(?:add|adding)\b|\b(?:additional|extra|another|second|third)\b[^.!?]{0,35}\b(?:camera|body|kit|lens|item|gear|equipment|monitor|light|microphone|mic|drone|gimbal)s?\b/.test(text);
  const replacement=/\b(?:replace|replacing|replacement|swap|instead)\b/.test(text);
  return additional===replacement ? undefined : additional ? "additional" : "replacement";
}

/** Build a read-only physical-stock proposal. A replacement removes units of
 * an exact commercial listing, never whichever component happens to match. */
export function recommendationBasket(existing: RecommendationLine[], candidate: RecommendationLine, context: {
  requires_booking_context: boolean; open_basket: boolean; can_replace: boolean;
  booking_use?: RecommendationUse; expected_use?: Exclude<RecommendationUse,"standalone">; replace_product_id?: number; replace_quantity?: number;
}) {
  const use = context.booking_use ?? context.expected_use ?? (context.requires_booking_context ? undefined : "standalone");
  const fail = (reason: string) => ({ok:false as const,reason,use,lines:[] as RecommendationLine[],removed:[] as RecommendationLine[]});
  if (context.expected_use && use !== context.expected_use) return fail("recommendation_use_conflicts_with_latest_request");
  if (!Number.isInteger(candidate.qty) || candidate.qty < 1 || candidate.qty > 20) return fail("invalid_quantity");
  if (!use || (use === "standalone" && context.requires_booking_context)) return fail("choose_addition_or_exact_replacement");
  if (use === "standalone" || (use === "additional" && !context.open_basket))
    return {ok:true as const,use:"standalone" as const,lines:[{...candidate}],removed:[] as RecommendationLine[]};
  if (!existing.length) return fail("current_basket_unmapped");
  if (use === "additional") return {ok:true as const,use,lines:[...existing.map(l=>({...l})),{...candidate}],removed:[] as RecommendationLine[]};
  if (!context.open_basket) return fail("replacement_requires_open_basket");
  if (!context.can_replace) return fail("replacement_requires_return_confirmation");
  if (!Number.isInteger(context.replace_product_id) || Number(context.replace_product_id) <= 0) return fail("select_exact_replacement_listing");
  const matches=existing.map((line,index)=>({line,index})).filter(({line})=>line.product_id===context.replace_product_id);
  if (matches.length!==1) return fail("replacement_listing_missing_or_ambiguous");
  const {line,index}=matches[0];
  const removeQty=context.replace_quantity ?? candidate.qty;
  if (!Number.isInteger(removeQty) || removeQty<1 || removeQty>line.qty) return fail("invalid_replacement_quantity");
  const lines=existing.flatMap((old,i)=>i!==index ? [{...old}] : old.qty>removeQty ? [{...old,qty:old.qty-removeQty}] : []);
  return {ok:true as const,use,lines:[...lines,{...candidate}],removed:[{...line,qty:removeQty}]};
}
