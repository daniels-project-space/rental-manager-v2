import { isStandardAccessory } from "./reservations/itemUnits";
import { defaultAdapterUnits, type AdapterInventoryItem } from "./default_adapter_units";
import { resolveBundleMapping } from "./bundle_mapping";

type Inventory = AdapterInventoryItem;
type Mapping = { account_slug: string; product_id: number; note?:string; components: Array<{ item_id: unknown; qty: number }> };

/** Candidate offerings for one physical inventory item, in stable display order. */
export function baseListingCandidates<T extends { product_id: number; daily_price?: number }>(
  listings: T[],
  productIds: number[],
): T[] {
  const ids = new Set(productIds);
  return listings
    .filter((listing) => ids.has(listing.product_id) && typeof listing.daily_price === "number" && listing.daily_price > 0)
    .sort((a, b) => a.daily_price! - b.daily_price! || a.product_id - b.product_id);
}

export type BaseListingChoice<T> =
  | { status: "none" }
  | { status: "selected"; listing: T }
  | { status: "selection_required"; listings: T[] };

/** Resolve a physical item to a listing only when that choice is unambiguous. */
export function resolveBaseListingChoice<T extends { product_id: number; daily_price?: number }>(
  listings: T[],
  productIds: number[],
): BaseListingChoice<T> {
  const candidates = baseListingCandidates(listings, productIds);
  if (candidates.length === 0) return { status: "none" };
  if (candidates.length > 1) return { status: "selection_required", listings: candidates };
  return { status: "selected", listing: candidates[0] };
}

/** A base camera listing can include its cards/batteries, but not another
 * independently rented item or two bodies. A manual mapping wins over index. */
export function baseListingProductIds(account: string, itemId: string,
  index: Array<{ account_slug: string; product_id: number; item_id: unknown }>,
  overrides: Mapping[], inventory: Inventory[], listings: Array<{product_id:number;description?:string}> = []): number[] {
  const items = new Map(inventory.map((i) => [String(i._id), i]));
  const mappings = new Map(overrides.filter((o) => o.account_slug === account).map((o) => [o.product_id, o]));
  const primary = items.get(itemId);
  const supplied = primary ? defaultAdapterUnits(primary, inventory).components : [];
  const coversDescription=(productId:number,components:Mapping["components"],requireExplicit=false)=>{
    const description=listings.find(l=>l.product_id===productId)?.description;
    if (!description) return !requireExplicit;
    const declared=resolveBundleMapping(description,inventory);
    if (!declared.explicit) return !requireExplicit;
    const quantities=new Map<string,number>();
    for(const c of components) quantities.set(String(c.item_id),(quantities.get(String(c.item_id)) ?? 0)+c.qty);
    return (declared.structured || (declared.components.length===1 && declared.components[0].qty===1)) && !declared.unmatched.length &&
      declared.components.every(c=>(quantities.get(c.item_id) ?? 0)>=c.qty);
  };
  const qualifies = (o: Mapping) => o.components.some((c) => String(c.item_id) === itemId && c.qty === 1) &&
    o.components.every((c) => {
      if (String(c.item_id) === itemId) return c.qty === 1;
      const item = items.get(String(c.item_id));
      return !!item && (isStandardAccessory(item.kind, item.name_canonical) || supplied.some(a => a.item_id === String(c.item_id) && c.qty <= a.qty));
    }) && coversDescription(o.product_id,o.components,/body-only-fallback/i.test(o.note ?? ""));
  const pids = new Set<number>();
  for (const row of index) {
    if (row.account_slug !== account || String(row.item_id) !== itemId) continue;
    const mapped = mappings.get(row.product_id);
    if (mapped ? qualifies(mapped) : coversDescription(row.product_id,[{item_id:itemId,qty:1}])) pids.add(row.product_id);
  }
  for (const o of mappings.values()) if (qualifies(o)) pids.add(o.product_id);
  return [...pids];
}
