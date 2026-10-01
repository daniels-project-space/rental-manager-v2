import type { QueryCtx } from "../_generated/server";
import { listingDisplayName } from "./item_display_name";

/** One shared catalog per query; never an N-per-card database lookup. */
export async function listingDisplayCatalog(ctx: QueryCtx, account?: string) {
  const [items, mappings, names] = await Promise.all([
    ctx.db.query("items").collect(),
    account ? ctx.db.query("listing_resolution_override").withIndex("by_account_product", q => q.eq("account_slug", account)).collect() : ctx.db.query("listing_resolution_override").collect(),
    account ? ctx.db.query("listing_short_names").withIndex("by_account_product", q => q.eq("account_slug", account)).collect() : ctx.db.query("listing_short_names").collect(),
  ]);
  const itemMap = new Map(items.map(i => [String(i._id), i]));
  const mappingMap = new Map(mappings.map(m => [`${m.account_slug}#${m.product_id}`, m]));
  const manualMap = new Map(names.filter(n => n.derivation_method === "manual").map(n => [`${n.account_slug}#${n.product_id}`, n.short_name]));
  return { items, mappingMap, itemMap, name: (accountSlug: string, pid: number, raw: string) => {
    const key = `${accountSlug}#${pid}`;
    return listingDisplayName(raw, mappingMap.get(key), itemMap, manualMap.get(key));
  } };
}
