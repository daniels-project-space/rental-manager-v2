import { recommendationBasket, type RecommendationLine, type RecommendationUse } from "./recommendation_basket";

type Context = Parameters<typeof recommendationBasket>[2];
/** Current gear is a separate read-only scope, never a proposed extra unit. */
export function availabilityBasket(existing: RecommendationLine[], candidate: RecommendationLine,
  context: Omit<Context,"booking_use"> & { booking_use?: RecommendationUse | "current";current_context?:boolean }) {
  if (context.booking_use !== "current") return recommendationBasket(existing,candidate,{...context,booking_use:context.booking_use});
  if (context.expected_use && !context.current_context)
    return {ok:false as const,reason:"current_check_conflicts_with_proposed_change",use:"current" as const,lines:[],removed:[]};
  const matches=existing.filter(line=>candidate.product_id != null ? line.product_id===candidate.product_id
    : candidate.item_id ? line.item_id===candidate.item_id : line.name.toLowerCase()===candidate.name.toLowerCase());
  if (!context.open_basket || matches.length!==1 || !Number.isInteger(candidate.qty) || candidate.qty<1 || candidate.qty>matches[0].qty)
    return {ok:false as const,reason:"current_listing_missing_or_quantity_mismatch",use:"current" as const,lines:[],removed:[]};
  return {ok:true as const,use:"current" as const,lines:existing.map(line=>({...line})),removed:[]};
}
