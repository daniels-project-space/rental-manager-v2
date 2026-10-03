import { resolveBundleMapping } from "./lib/bundle_mapping";
import { loadListingInventory } from "./lib/listing_inventory";
import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { baseListingProductIds } from "./lib/base_listing_identity";
import { loadStockSources, stockForItem } from "./lib/renter_stock";
import { reservationItemUnits } from "./lib/reservations/itemUnits";
import { defaultAdapterUnits } from "./lib/default_adapter_units";
import { londonToday } from "./lib/effectiveDates";

/** Read-only comparison against actual confirmed/ongoing bookings; no renter
 * names, message bodies or mutation of imported reservations. */
export const adapterStock = internalQuery({
  args:{},
  handler:async(ctx)=>{
    const sources=await loadStockSources(ctx);
    const adapterIds=new Set(sources.items.flatMap(i=>defaultAdapterUnits(i,sources.items).components.map(c=>c.item_id)));
    const changes=sources.reservations.flatMap(r=>{
      const before=reservationItemUnits(r,sources.productIndex,sources.overrides);
      const after=reservationItemUnits(r,sources.productIndex,sources.overrides,sources.items);
      return [...adapterIds].filter(id=>(after.get(id)??0)!==(before.get(id)??0)).map(id=>({
        order_id:r.hygglo_order_id,account_slug:r.account_slug,start_date:r.start_date,end_date:r.end_date,
        adapter:sources.items.find(i=>String(i._id)===id)?.name_canonical,before:before.get(id)??0,after:after.get(id)??0,
      }));
    });
    const today=londonToday();
    const stock=sources.items.filter(i=>adapterIds.has(String(i._id))).map(i=>{
      const checked=stockForItem(sources,i,{item_name:i.name_canonical,start_date:today,end_date:today});
      return {name:i.name_canonical,total_units:checked.total_units,free_units:checked.free_units,per_day:checked.per_day};
    });
    return {today,changed_allocations:changes,stock};
  },
});

/**
 * Which rentable items have NO resolvable price on an account?
 *
 * Found live in a sweep: the renter asked for a total, the bot had added the
 * DJI Wireless Mics, and no price existed for it — so the total was
 * uncomputable and the best the bot could honestly do was stall ("I'm just
 * checking the listing rate"). Every such item is a conversation the bot
 * cannot finish.
 *
 * Resolution mirrors the renter-facing path exactly: listing via
 * hygglo_product_index ∪ single-item listing_resolution_override (cheapest),
 * then the curated pricing_catalog. Read-only.
 */
export const check = internalQuery({
  args: { account_slug: v.string(), item_names: v.optional(v.array(v.string())) },
  handler: async (ctx, { account_slug, item_names }) => {
    const items = (await ctx.db.query("items").collect()).filter(
      (i) => i.status === "active" && !i.is_marketing_only && (i.qty ?? 0) > 0,
    );
    const listings = await ctx.db
      .query("online_listings")
      .withIndex("by_account", (q) => q.eq("account_slug", account_slug))
      .collect();
    const idx = await ctx.db.query("hygglo_product_index").collect();
    const ov = await ctx.db.query("listing_resolution_override").collect();
    const cat = await ctx.db.query("pricing_catalog").collect();
    const catByName = new Map(
      cat.map((c) => [c.item_name_canonical.toLowerCase().trim(), c.daily_price_min]),
    );
    const priceByPid = new Map(
      listings.map((l) => [l.product_id, l.daily_price]),
    );

    const missing: Array<{ name: string; qty: number; kind: string }> = [];
    let viaListing = 0;
    let viaCatalog = 0;
    const details = [];
    for (const it of items) {
      const pids = baseListingProductIds(account_slug, String(it._id), idx, ov, items,listings);
      if (item_names?.includes(it.name_canonical)) details.push({
        name: it.name_canonical,
        listings: pids.map(pid => ({ product_id: pid, title: listings.find(l => l.product_id === pid)?.name,
          daily_price: priceByPid.get(pid),
          mapping: ov.find(o => o.account_slug === account_slug && o.product_id === pid)?.components.map(c => ({
            name: items.find(i => String(i._id) === String(c.item_id))?.name_canonical, qty:c.qty
          })) })),
        catalog: cat.filter(c => !c.marketing_only && !c.is_bundle && c.item_name_canonical === it.name_canonical)
          .map(c => ({daily_price_min:c.daily_price_min,daily_price_max:c.daily_price_max})),
      });
      let best: number | null = null;
      for (const pid of pids) {
        const p = priceByPid.get(pid);
        if (typeof p === "number" && (best === null || p < best)) best = p;
      }
      if (best !== null) {
        viaListing++;
        continue;
      }
      if (catByName.get(it.name_canonical.toLowerCase().trim()) != null) {
        viaCatalog++;
        continue;
      }
      missing.push({ name: it.name_canonical, qty: it.qty ?? 0, kind: it.kind });
    }
    return {
      account_slug,
      rentable_items: items.length,
      priced_from_listing: viaListing,
      priced_from_catalog: viaCatalog,
      unpriceable: missing.length,
      missing: missing.sort((a, b) => a.kind.localeCompare(b.kind)).slice(0, 40),
      details,
    };
  },
});

export default internalAction({
  args: { account_slug: v.string(), item_names: v.optional(v.array(v.string())) },
  handler: async (ctx, a): Promise<unknown> =>
    ctx.runQuery(internal.diag_price_coverage.check, a),
});


/** Read-only contents/identity diagnosis for explicit account listing IDs.
 * Uses the same parser and coverage contract as actual bot tools. */
export const componentMapping=internalQuery({args:{account_slug:v.string(),product_ids:v.array(v.number())},handler:async(ctx,a)=>{
 if(a.product_ids.length>10||a.product_ids.some(id=>!Number.isInteger(id)||id<=0))throw new Error("Supply at most ten exact product IDs");
 const items=await ctx.db.query("items").collect();
 return Promise.all([...new Set(a.product_ids)].map(async product_id=>{
  const listing=await ctx.db.query("online_listings").withIndex("by_account_product",q=>q.eq("account_slug",a.account_slug).eq("product_id",product_id)).unique();
  if(!listing)return {product_id,found:false as const};
  const declared=resolveBundleMapping(listing.description??"",items);
  const physical=await loadListingInventory(ctx,a.account_slug,product_id,1,{items});
  return {product_id,found:true as const,account_slug:a.account_slug,title:listing.name,declared,physical};
 }));
}});
