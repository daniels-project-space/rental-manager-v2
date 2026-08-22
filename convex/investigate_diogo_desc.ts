import { internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Inspect diogo's Blackmagic listing descriptions specifically.
 *
 * Two things to establish:
 *  1. Are diogo's descriptions genuinely more structured than leo's? (Daniel
 *     says they are, and the earlier sampling was leo-heavy.)
 *  2. Are we TRUNCATING them? online_listings.setDescription stores
 *     `description.slice(0, 600)`, so a detailed description would be cut off
 *     mid-list — which would explain why the component parse kept losing the
 *     tail of longer kits.
 */
export const probe = internalQuery({
  args: {},
  handler: async (ctx) => {
    const RE = /blackmagic|bmpcc|bmpc\b|pocket cinema/i;
    const listings = (await ctx.db.query("online_listings").collect()).filter(
      (l) => l.account_slug === "diogo" && RE.test(l.name ?? ""),
    );
    const withDesc = listings.filter((l) => (l.description ?? "").length > 0);
    const lens = withDesc.map((l) => (l.description ?? "").length).sort((a, b) => b - a);
    return {
      diogo_blackmagic_listings: listings.length,
      with_description: withDesc.length,
      // 600 is the storage cap — anything at exactly 600 is truncated.
      at_cap_600: lens.filter((n) => n >= 600).length,
      length_max: lens[0] ?? 0,
      length_median: lens[Math.floor(lens.length / 2)] ?? 0,
      samples: withDesc.slice(0, 4).map((l) => ({
        key: `${l.account_slug}#${l.product_id}`,
        price: l.daily_price ?? null,
        len: (l.description ?? "").length,
        title: (l.name ?? "").replace(/[^\x20-\x7E]/g, "").slice(0, 70),
        desc: (l.description ?? "").replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").slice(0, 620),
      })),
    };
  },
});

export default internalAction({
  handler: async (ctx): Promise<unknown> =>
    ctx.runQuery(internal.investigate_diogo_desc.probe, {}),
});
