import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { resolveListingComponents } from "./listing_components";
import type { OverrideMap } from "./reservations/itemUnits";

type Override = Pick<Doc<"listing_resolution_override">,"account_slug"|"product_id"|"components">;
type Product = Pick<Doc<"hygglo_products">,"accountSlug"|"productId"|"masterItemId"|"description">;
type Listing = Pick<Doc<"online_listings">,"account_slug"|"product_id"|"description">;

/** The same physical requirements for offered kits and occupied rentals.
 * First rows match indexed .first() readers. An explicit empty owner mapping
 * remains an exclusion. Never rewrite frozen website per-item allocations.
 */
export function canonicalListingAllocation(items: Doc<"items">[], overrides: Override[], products: Product[], listings: Listing[]): OverrideMap {
  const result: OverrideMap = new Map();
  for (const row of overrides) {
    const key=`${row.account_slug}#${row.product_id}`;
    if (!result.has(key)) result.set(key,row.components.map(c=>({item_id:String(c.item_id),qty:c.qty})));
  }
  const descriptions=new Map<string,string|undefined>();
  for (const row of listings) {
    const key=`${row.account_slug}#${row.product_id}`;
    if (!descriptions.has(key)) descriptions.set(key,row.description);
  }
  const seen=new Set<string>();
  for (const product of products) {
    const key=`${product.accountSlug}#${product.productId}`;
    if (seen.has(key))continue;
    seen.add(key);
    const original=result.get(key);
    if (original?.length===0)continue;
    const resolved=resolveListingComponents(items,original,product.masterItemId?String(product.masterItemId):undefined,1,
      product.description??descriptions.get(key));
    // Only proved whole contents may replace legacy reservation fallbacks.
    // Partial unknown kits retain their existing audited held units.
    if (!resolved.complete || resolved.owned!==true)continue;
    result.set(key,resolved.components.map(c=>({item_id:c.item_id,qty:c.units_per_listing})));
  }
  return result;
}

export async function loadCanonicalListingAllocation(ctx: QueryCtx, inventory?: Doc<"items">[], overrideRows?: Override[]): Promise<OverrideMap> {
  const [items,overrides,products,listings]=await Promise.all([
    inventory??ctx.db.query("items").collect(),
    overrideRows??ctx.db.query("listing_resolution_override").collect(),
    ctx.db.query("hygglo_products").collect(),
    ctx.db.query("online_listings").collect(),
  ]);
  return canonicalListingAllocation(items,overrides,products,listings);
}
