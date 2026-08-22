/**
 * Non-node companion to backfill_blackmagic_descriptions.ts.
 *
 * Convex forbids defining queries in a "use node" module, so the target
 * selection lives here while the Hygglo fetch stays in the Node action.
 */
import { internalQuery } from "./_generated/server";

export const targets = internalQuery({
  args: {},
  handler: async (ctx) => {
    const RE = /blackmagic|bmpcc|bmpc\b|pocket cinema/i;
    const [listings, index, overrides] = await Promise.all([
      ctx.db.query("online_listings").collect(),
      ctx.db.query("hygglo_product_index").collect(),
      ctx.db.query("listing_resolution_override").collect(),
    ]);
    const mapped = new Set([
      ...index.map((r) => `${r.account_slug}#${r.product_id}`),
      ...overrides.map((r) => `${r.account_slug}#${r.product_id}`),
    ]);
    return listings
      .filter((l) => {
        const t = (l.name ?? "");
        if (!RE.test(t)) return false;
        if (/pyxis/i.test(t)) return false; // different camera, ruled marketing
        if (mapped.has(`${l.account_slug}#${l.product_id}`)) return false;
        return !l.description; // only those still missing one
      })
      .map((l) => ({ account_slug: l.account_slug, product_id: l.product_id }));
  },
});
