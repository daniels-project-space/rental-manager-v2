import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { loadStockSources, stockForItem, type StockRequest } from "./renter_stock";

import type { PriceTier } from "./hygglo_pricing";
import { resolveListingComponents } from "./listing_components";
export { resolveListingComponents } from "./listing_components";


export async function loadListingInventory(ctx: QueryCtx, account: string, productId: number, quantity = 1,
  sources?: Pick<Awaited<ReturnType<typeof loadStockSources>>, "items">) {
  const [override, product, listing] = await Promise.all([
    ctx.db.query("listing_resolution_override").withIndex("by_account_product", (q) => q.eq("account_slug", account).eq("product_id", productId)).first(),
    ctx.db.query("hygglo_products").withIndex("by_account_product", (q) => q.eq("accountSlug", account).eq("productId", productId)).first(),
    ctx.db.query("online_listings").withIndex("by_account_product", (q) => q.eq("account_slug", account).eq("product_id", productId)).first(),
  ]);
  const inventory = sources?.items ?? await ctx.db.query("items").collect();
  return { ...resolveListingComponents(inventory, override?.components.map((c) => ({ item_id: String(c.item_id), qty: c.qty })), product?.masterItemId ? String(product.masterItemId) : undefined, quantity, product?.description ?? listing?.description),
    product_id: productId, listing_name: product?.name ?? null,
    // Already read for physical resolution: reuse this exact offering's price
    // instead of another tool call or repeating catalogue reads per component.
    offering: listing && product?.name?.trim() ? {product_id:productId,name:product.name,
      qty:quantity,daily_price_gbp:listing.daily_price,price_tiers:(product.prices ?? [])
        .filter(p=>typeof p.days==="number" && typeof p.pricePerDay==="number" && p.pricePerDay>0)
        .map(p=>({days:p.days,pricePerDay:p.pricePerDay})) as PriceTier[],
      pricing_basis:"listing" as const} : null };
}

export function listingStock(sources: Awaited<ReturnType<typeof loadStockSources>>, listing: Omit<Awaited<ReturnType<typeof loadListingInventory>>,"offering">, request: StockRequest) {
  const components = listing.components.filter((c) => c.stock_required).map((c) => {
    const item = sources.items.find((i) => String(i._id) === c.item_id);
    if (!item) return { item_name: c.name ?? "Unmapped component", available: null, free_units: null, total_units: null,
      requested_units: c.requested_units, reason: "unmapped_component", owned: null,
      start_date: request.start_date, end_date: request.end_date, checked_at: Date.now(), units_per_listing: c.units_per_listing };
    return { ...stockForItem(sources, item, { ...request, item_name: item.name_canonical, quantity: c.requested_units }),
      start_date: request.start_date, end_date: request.end_date, units_per_listing: c.units_per_listing };
  });
  const negative = listing.owned === false || components.some((c) => c.available === false);
  const identityVerified=!!listing.listing_name?.trim();
  const available = !identityVerified || !listing.valid_quantity ? null : negative ? false
    : listing.complete && listing.owned === true && components.length > 0 && components.every((c) => c.available === true) ? true : null;
  const capacity = (key: "free_units" | "total_units") => components.length && components.every((c) => typeof c[key] === "number")
    ? Math.min(...components.map((c) => Math.floor(c[key]! / c.units_per_listing))) : null;
  return { available, owned: identityVerified ? listing.owned : null, found: identityVerified && listing.complete, item_name: listing.listing_name ?? "Unverified listing identity",
    product_id: listing.product_id, requested_units: request.quantity ?? 1, free_units: capacity("free_units"), total_units: capacity("total_units"),
    start_date: request.start_date, end_date: request.end_date, checked_at: Date.now(), source: "complete_listing_components",
    reason: !identityVerified ? "listing_identity_unverified" : !listing.valid_quantity ? "invalid_request" : listing.owned === false ? "not_rentable" : negative ? "component_unavailable" : available === true ? "available" : "incomplete_listing_mapping",
    components, conflicts: [], mapping_complete: listing.complete };
}
