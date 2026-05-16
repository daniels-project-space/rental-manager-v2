/**
 * Phase 16.1 B1 — denial_resolver result cache.
 *
 * Mirror of the listing_resolutions cache pattern from Phase 15.1. Keyed by
 * (account_slug, item_name_normalised) and gated by inventory_fingerprint so
 * adding/removing inventory items auto-invalidates the cache. Eliminates
 * 50-80% of denial_resolver Grok-4.3 calls after a few days of warmup
 * (denial product names recur constantly: Sony FX3, Aputure 600D, etc.).
 */
import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";

export const lookup = internalQuery({
  args: {
    account_slug: v.string(),
    item_name_normalised: v.string(),
    inventory_fingerprint: v.string(),
  },
  handler: async (ctx, { account_slug, item_name_normalised, inventory_fingerprint }) => {
    const row = await ctx.db
      .query("denial_resolutions")
      .withIndex("by_account_normname", (q) =>
        q.eq("account_slug", account_slug).eq("item_name_normalised", item_name_normalised),
      )
      .first();
    if (!row) return null;
    // Inventory churn invalidates the cache entry. Future denials with the
    // new fingerprint will re-resolve via LLM and overwrite the row.
    if (row.inventory_fingerprint !== inventory_fingerprint) return null;
    return row;
  },
});

export const accountSlugForRow = internalQuery({
  args: { id: v.id("denial_records") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row) return null;
    if (!row.account_id) return null;
    const acc = await ctx.db.get(row.account_id);
    return (acc as { slug?: string } | null)?.slug ?? null;
  },
});

export const upsert = internalMutation({
  args: {
    account_slug: v.string(),
    item_name_normalised: v.string(),
    inventory_fingerprint: v.string(),
    resolved_item_id: v.optional(v.id("items")),
    resolution_confidence: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("denial_resolutions")
      .withIndex("by_account_normname", (q) =>
        q.eq("account_slug", args.account_slug).eq("item_name_normalised", args.item_name_normalised),
      )
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        inventory_fingerprint: args.inventory_fingerprint,
        resolved_item_id: args.resolved_item_id,
        resolution_confidence: args.resolution_confidence,
        last_used_at: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("denial_resolutions", {
      account_slug: args.account_slug,
      item_name_normalised: args.item_name_normalised,
      inventory_fingerprint: args.inventory_fingerprint,
      resolved_item_id: args.resolved_item_id,
      resolution_confidence: args.resolution_confidence,
      hit_count: 0,
      created_at: now,
      last_used_at: now,
    });
  },
});

export const bumpHit = internalMutation({
  args: { _id: v.id("denial_resolutions") },
  handler: async (ctx, { _id }) => {
    const row = await ctx.db.get(_id);
    if (!row) return;
    await ctx.db.patch(_id, {
      hit_count: (row.hit_count ?? 0) + 1,
      last_used_at: Date.now(),
    });
  },
});
