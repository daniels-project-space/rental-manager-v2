import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

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
  args: { account_slug: v.string() },
  handler: async (ctx, { account_slug }) => {
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
    for (const it of items) {
      const pids = [
        ...idx
          .filter((r) => String(r.item_id) === String(it._id) && r.account_slug === account_slug)
          .map((r) => r.product_id),
        ...ov
          .filter(
            (o) =>
              o.account_slug === account_slug &&
              o.components.length === 1 &&
              String(o.components[0].item_id) === String(it._id),
          )
          .map((o) => o.product_id),
      ];
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
    };
  },
});

export default internalAction({
  args: { account_slug: v.string() },
  handler: async (ctx, a): Promise<unknown> =>
    ctx.runQuery(internal.diag_price_coverage.check, a),
});
