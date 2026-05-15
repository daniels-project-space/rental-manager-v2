/**
 * Internal queries/mutations for the denial canonicalizer.
 * Split from the action so the node-runtime file stays minimal.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const listUnresolvedDenials = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const all = await ctx.db.query("denial_records").collect();
    const need = all
      .filter(
        (d) =>
          d.canonical_product === undefined &&
          d.item_name !== undefined &&
          d.item_name.trim().length > 0
      )
      // Newest first — same prioritisation as the item resolver.
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, limit)
      .map((d) => ({ id: d._id as string, item_name: d.item_name as string }));
    return need;
  },
});

export const setDenialCanonical = internalMutation({
  args: {
    denial_id: v.id("denial_records"),
    canonical_product: v.string(),
    canonical_brand: v.string(),
    canonical_kind: v.string(),
  },
  handler: async (ctx, { denial_id, canonical_product, canonical_brand, canonical_kind }) => {
    await ctx.db.patch(denial_id, {
      canonical_product,
      canonical_brand,
      canonical_kind,
      canonicalized_at: Date.now(),
    });
  },
});
