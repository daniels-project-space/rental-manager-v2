export type RecommendationLine = { name: string; qty: number; item_id?: string; product_id?: number };
export type RecommendationUse = "standalone" | "additional" | "replacement" | "separate";

/** Only unambiguous wording supplies an inferred stock scenario. This is not
 * permission to edit a booking; mixed/conditional wording still needs context. */
export function explicitRecommendationUse(message: string): Exclude<RecommendationUse,"standalone"|"separate"> | undefined {
  const text=message.toLowerCase().replace(/[’‘]/g,"'");
  const additional=/\b(?:add|adding)\b|\b(?:additional|extra|another|second|third)\b[^.!?]{0,35}\b(?:camera|body|kit|lens|item|gear|equipment|monitor|light|microphone|mic|drone|gimbal)s?\b/.test(text);
  const replacement=/\b(?:replace|replacing|replacement|swap|instead)\b/.test(text);
  return additional===replacement ? undefined : additional ? "additional" : "replacement";
}

/** Build a read-only physical-stock proposal. A replacement removes units of
 * an exact commercial listing, never whichever component happens to match. */
export function recommendationBasket(existing: RecommendationLine[], candidate: RecommendationLine, context: {
  requires_booking_context: boolean; open_basket: boolean; can_replace: boolean;
  booking_use?: RecommendationUse; expected_use?: Exclude<RecommendationUse,"standalone"|"separate">; replace_product_id?: number; replace_quantity?: number;
}) {
  const use = context.booking_use ?? context.expected_use ?? (context.requires_booking_context ? undefined : "standalone");
  const fail = (reason: string) => ({ok:false as const,reason,use,lines:[] as RecommendationLine[],removed:[] as RecommendationLine[]});
  if (context.expected_use && use !== context.expected_use) return fail("recommendation_use_conflicts_with_latest_request");
  if (!Number.isInteger(candidate.qty) || candidate.qty < 1 || candidate.qty > 20) return fail("invalid_quantity");
  if (!use || (use === "standalone" && context.requires_booking_context)) return fail("choose_addition_or_exact_replacement");
  if (use === "standalone" || use === "separate" || (use === "additional" && !context.open_basket))
    return {ok:true as const,use:use==="separate"?"separate" as const:"standalone" as const,lines:[{...candidate}],removed:[] as RecommendationLine[]};
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

/**
 * Validate a complete read-only proposal for an open inquiry. Unlike
 * recommendationBasket(), `proposed` lines are final quantities, not deltas.
 * This lets one Native stock/price check evaluate combined date + basket
 * changes without interpreting model-supplied quantities as additions.
 */
export function proposedInquiryBasket(existing: RecommendationLine[], proposed: RecommendationLine[], context: {
  open_basket: boolean;
  expected_use?: Exclude<RecommendationUse,"standalone"|"separate">;
}) {
  const fail = (reason: string) => ({ok:false as const,reason,use:"proposed" as const,lines:[] as RecommendationLine[]});
  if (!proposed.length) return fail("proposed_basket_empty");
  if (proposed.length > 8) return fail("use_one_to_eight_exact_items");
  if (context.expected_use === "replacement") return fail("replacement_requires_exact_listing_selection");
  if (!context.open_basket || !existing.length)
    return {ok:true as const,use:"proposed" as const,lines:proposed.map(line=>({...line}))};

  const identity = (line: RecommendationLine) => line.product_id != null
    ? `product:${line.product_id}`
    : line.item_id ? `item:${line.item_id}` : `name:${line.name.trim().toLowerCase().replace(/\s+/g," ")}`;
  const proposedById = new Map<string, RecommendationLine>();
  for (const line of proposed) {
    const key=identity(line), prior=proposedById.get(key);
    if (prior) return fail("duplicate_proposed_basket_line");
    proposedById.set(key,line);
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > 20) return fail("invalid_quantity");
  }
  let increased=false;
  for (const current of existing) {
    const next=proposedById.get(identity(current));
    if (!next || next.qty < current.qty) return fail("proposed_basket_drops_current_item");
    if (next.qty > current.qty) increased=true;
  }
  if (context.expected_use === "additional" && !increased && !proposed.some(line=>!existing.some(current=>identity(current)===identity(line))))
    return fail("proposed_basket_does_not_include_requested_addition");
  return {ok:true as const,use:"proposed" as const,lines:proposed.map(line=>({...line}))};
}
