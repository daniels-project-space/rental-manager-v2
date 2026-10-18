import type { Doc, Id } from "../_generated/dataModel";

/** Exact account listing evidence: owner-pinned inventory identity and matching live-catalog day rate. */
export function hasOwnerPinnedDailyRate(
  product: Doc<"hygglo_products">,
  itemId: Id<"items">,
  dailyRate: number,
): boolean {
  if (product.isPublished !== true || product.stockIdentityOverride?.itemId !== itemId) return false;
  return (product.prices ?? []).some((tier) => {
    const rate = tier.pricePerDay ?? (tier.days && tier.days > 0 ? (tier.price ?? 0) / tier.days : tier.price);
    return typeof rate === "number" && Number.isFinite(rate) && Math.abs(rate - dailyRate) < 0.005;
  });
}
