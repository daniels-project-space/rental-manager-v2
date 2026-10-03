import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isStandardAccessory } from "./reservations/itemUnits";
import { loadStockSources, stockForItem, type StockRequest } from "./renter_stock";

import { resolveBundleMapping } from "./bundle_mapping";
import { withDefaultAdapters } from "./default_adapter_units";

type Component = { item_id: string; qty: number };
export function resolveListingComponents(items: Doc<"items">[], override: Component[] | undefined, primaryId?: string, quantity = 1, description?: string) {
  const validQuantity = Number.isInteger(quantity) && quantity >= 1 && quantity <= 20;
  const quantities = new Map<string, number>();
  for (const c of override ?? (primaryId ? [{ item_id: primaryId, qty: 1 }] : []))
    quantities.set(c.item_id, (quantities.get(c.item_id) ?? 0) + c.qty);
  const supplied = withDefaultAdapters([...quantities].map(([item_id,qty]) => ({item_id,qty})), items);
  for (const c of supplied.components) quantities.set(c.item_id,c.qty);
  const components = [...quantities].map(([item_id, qty]) => {
    const item = items.find((i) => String(i._id) === item_id);
    const valid = Number.isInteger(qty) && qty > 0;
    return { item_id, name: item?.name_canonical ?? null, kind: item?.kind ?? null,
      units_per_listing: qty, requested_units: qty * quantity,
      stock_required: !item || item.track_independent_stock === true || !isStandardAccessory(item.kind, item.name_canonical),
      owned: !item || !valid ? null : item.status === "active" && !item.is_marketing_only && item.qty > 0 };
  });
  const declared = description ? resolveBundleMapping(description, items) : null;
  const coverage = declared?.explicit ? {
    missing: declared.components.filter(c => (quantities.get(c.item_id) ?? 0) < c.qty).map(c => ({item_id:c.item_id,name:c.name,qty:c.qty})),
    unresolved: declared.unmatched,
    structured: declared.structured || (declared.components.length === 1 && declared.components[0].qty === 1),
  } : null;
  const coverageComplete = !coverage || (coverage.structured && !coverage.missing.length && !coverage.unresolved.length);
  const complete = !supplied.unresolved.length && coverageComplete && override !== undefined && validQuantity && components.every((c) => c.owned !== null);
  const owned = !validQuantity ? null : override?.length === 0 || components.some((c) => c.owned === false) ? false
    : !complete || !components.length ? null : true;
  return { components, complete, owned, valid_quantity: validQuantity, source: override === undefined ? "primary_item_only" : "listing_override", coverage, unresolved_default_adapters:supplied.unresolved };
}

export async function loadListingInventory(ctx: QueryCtx, account: string, productId: number, quantity = 1,
  sources?: Pick<Awaited<ReturnType<typeof loadStockSources>>, "items">) {
  const [override, product, listing] = await Promise.all([
    ctx.db.query("listing_resolution_override").withIndex("by_account_product", (q) => q.eq("account_slug", account).eq("product_id", productId)).first(),
    ctx.db.query("hygglo_products").withIndex("by_account_product", (q) => q.eq("accountSlug", account).eq("productId", productId)).first(),
    ctx.db.query("online_listings").withIndex("by_account_product", (q) => q.eq("account_slug", account).eq("product_id", productId)).first(),
  ]);
  const inventory = sources?.items ?? await ctx.db.query("items").collect();
  return { ...resolveListingComponents(inventory, override?.components.map((c) => ({ item_id: String(c.item_id), qty: c.qty })), product?.masterItemId ? String(product.masterItemId) : undefined, quantity, listing?.description),
    product_id: productId, listing_name: product?.name ?? null };
}

export function listingStock(sources: Awaited<ReturnType<typeof loadStockSources>>, listing: Awaited<ReturnType<typeof loadListingInventory>>, request: StockRequest) {
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
