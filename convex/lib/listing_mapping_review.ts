export type ListingMappingReviewStatus =
  | "verified"
  | "needs_review"
  | "no_physical_stock"
  | "marketing_only"
  | "duplicate_maps";

export function isSelectableListingMappingItem(item: {
  status: string;
  is_marketing_only: boolean;
  qty: number;
}): boolean {
  return item.status === "active" && !item.is_marketing_only &&
    Number.isSafeInteger(item.qty) && item.qty > 0;
}

export function listingMappingReviewStatus(input: {
  isMarketingOnly: boolean;
  mappingConflict: boolean;
  hasOverride: boolean;
  componentCount: number;
  complete: boolean;
  owned: boolean | null;
}): ListingMappingReviewStatus {
  if (input.isMarketingOnly) return "marketing_only";
  if (input.mappingConflict) return "duplicate_maps";
  if (input.hasOverride && input.componentCount === 0) return "no_physical_stock";
  if (input.complete && input.owned === true) return "verified";
  return "needs_review";
}
