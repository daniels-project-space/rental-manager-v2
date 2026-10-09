import { createBundleMappingContext } from "./bundle_mapping";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { resolveListingComponents } from "./listing_components";
import type { OverrideMap, ResolvableRes } from "./reservations/itemUnits";

type Override = Pick<Doc<"listing_resolution_override">,"account_slug"|"product_id"|"components">;
type Product = Pick<Doc<"hygglo_products">,"accountSlug"|"productId"|"masterItemId"|"description">;
type Listing = Pick<Doc<"online_listings">,"account_slug"|"product_id"|"description">;

/** The same physical requirements for offered kits and occupied rentals.
 * First rows match indexed .first() readers. An explicit empty owner mapping
 * remains an exclusion. Never rewrite frozen website per-item allocations.
 */
export function canonicalListingAllocation(items: Doc<"items">[], overrides: Override[], products: Product[], listings: Listing[]): OverrideMap {
  const result: OverrideMap = new Map();
  const context=createBundleMappingContext(items);
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
      product.description??descriptions.get(key),context);
    // Only proved whole contents may replace legacy reservation fallbacks.
    // Partial unknown kits retain their existing audited held units.
    if (!resolved.complete || resolved.owned!==true)continue;
    result.set(key,resolved.components.map(c=>({item_id:c.item_id,qty:c.units_per_listing})));
  }
  return result;
}

/** Only booked listing identities need contents for occupancy. Unrelated
 * catalogue descriptions must not be scanned for every stock/calendar query. */
export function reservedListingKeys(rentals: ResolvableRes[]): Array<{account:string;productId:number}> {
  const keys=new Map<string,{account:string;productId:number}>();
  for(const r of rentals){
    if(!r.account_slug || r.account_slug==="dbcinema_web" && r.site_item_windows!==undefined)continue;
    for(const h of r.hygglo_items??[]){
      if(!Number.isSafeInteger(h.product_id))continue;
      const productId=h.product_id!;
      keys.set(`${r.account_slug}#${productId}`,{account:r.account_slug,productId});
    }
  }
  return [...keys.values()];
}

export async function loadCanonicalListingAllocation(ctx: QueryCtx, inventory?: Doc<"items">[], overrideRows?: Override[], rentals?: ResolvableRes[]): Promise<OverrideMap> {
  const keys=rentals===undefined?undefined:reservedListingKeys(rentals);
  const [items,overrides,products,listings]=await Promise.all([
    inventory??ctx.db.query("items").collect(),
    overrideRows??ctx.db.query("listing_resolution_override").collect(),
    keys===undefined?ctx.db.query("hygglo_products").collect():Promise.all(keys.map(k=>ctx.db.query("hygglo_products")
      .withIndex("by_account_product",q=>q.eq("accountSlug",k.account).eq("productId",k.productId)).first())).then(rows=>rows.filter((r):r is Doc<"hygglo_products">=>r!==null)),
    keys===undefined?ctx.db.query("online_listings").collect():Promise.all(keys.map(k=>ctx.db.query("online_listings")
      .withIndex("by_account_product",q=>q.eq("account_slug",k.account).eq("product_id",k.productId)).first())).then(rows=>rows.filter((r):r is Doc<"online_listings">=>r!==null)),
  ]);
  return canonicalListingAllocation(items,overrides,products,listings);
}
