/**
 * Phase 3c / Wave 3b — data layer for vision-elimination pipeline.
 *
 * Queries + mutations for item_image_phash + tier-distribution monitoring.
 * Split out from resolve_item_from_image.ts because that module is
 * "use node" (sharp + Gemini SDK) and node-runtime Convex modules may
 * only export actions.
 *
 * Callers: convex/resolve_item_from_image.ts and convex/migrations/
 * backfill_phash.ts reference these via internal.resolve_item_from_image_data.*.
 */

import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";

/**
 * Return all pHash rows. Caller computes Hamming distance in the action
 * runtime. We page through small chunks — table is bounded by unique
 * image URLs (≤ a few thousand even at scale).
 */
export const listAllPhashRows = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("item_image_phash").collect();
  },
});

/**
 * Lookup by exact phash. Cheap path before falling back to Hamming scan.
 */
export const findByExactPhash = internalQuery({
  args: { phash: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("item_image_phash")
      .withIndex("by_phash", (q) => q.eq("phash", args.phash))
      .first();
  },
});

/**
 * Lookup by image URL. Idempotency guard for writeback.
 */
export const findByImageUrl = internalQuery({
  args: { image_url: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("item_image_phash")
      .withIndex("by_image_url", (q) => q.eq("image_url", args.image_url))
      .first();
  },
});

/**
 * Upsert a pHash → item_id cache row.
 */
export const upsertPhashCache = internalMutation({
  args: {
    image_url: v.string(),
    phash: v.string(),
    canonical_item_id: v.id("items"),
    confidence: v.number(),
    source: v.union(v.literal("vision_resolve"), v.literal("backfill")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("item_image_phash")
      .withIndex("by_image_url", (q) => q.eq("image_url", args.image_url))
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        phash: args.phash,
        canonical_item_id: args.canonical_item_id,
        confidence: args.confidence,
        last_used_at: now,
        source: args.source,
      });
      return existing._id;
    }
    return await ctx.db.insert("item_image_phash", {
      image_url: args.image_url,
      phash: args.phash,
      canonical_item_id: args.canonical_item_id,
      confidence: args.confidence,
      last_used_at: now,
      source: args.source,
    });
  },
});

/**
 * Touch last_used_at on an existing cache row (Tier 1 hit).
 */
export const touchPhashRow = internalMutation({
  args: { id: v.id("item_image_phash") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { last_used_at: Date.now() });
  },
});

/**
 * List all items for Tier 3 fuzzy match.
 */
export const listItemsForFuzzyMatch = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("items").collect();
    return rows.map((r) => ({
      _id: r._id,
      name_canonical: r.name_canonical,
      name_input: r.name_input,
      aliases: r.aliases ?? [],
    }));
  },
});

/**
 * Internal helper — fetch one embedding row by id.
 */
export const _getEmbeddingRow = internalQuery({
  args: { id: v.id("item_embeddings") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

/**
 * Aggregate resolved_via_tier across reservation_vision over a window.
 */
export const getVisionTierDistribution = internalQuery({
  args: { windowHours: v.number() },
  handler: async (ctx, args): Promise<{
    tier1: number;
    tier2: number;
    tier3: number;
    tier4: number;
    none: number;
    total: number;
    window_hours: number;
  }> => {
    const cutoff = Date.now() - args.windowHours * 3_600_000;
    const rows = await ctx.db
      .query("reservation_vision")
      .withIndex("by_processed_at")
      .filter((q) => q.gte(q.field("vision_processed_at"), cutoff))
      .collect();
    let t1 = 0, t2 = 0, t3 = 0, t4 = 0, none = 0;
    for (const r of rows) {
      const tier = (r as any).resolved_via_tier as number | undefined;
      if (tier === 1) t1++;
      else if (tier === 2) t2++;
      else if (tier === 3) t3++;
      else if (tier === 4) t4++;
      else none++;
    }
    return {
      tier1: t1,
      tier2: t2,
      tier3: t3,
      tier4: t4,
      none,
      total: rows.length,
      window_hours: args.windowHours,
    };
  },
});

/**
 * Items list for phash backfill (image_url scan). Moved from
 * migrations/backfill_phash.ts for the same node-runtime reason.
 */
export const _listItemsForPhashBackfill = internalQuery({
  args: {
    after_creation_time: v.optional(v.number()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("items")
      .filter((q) =>
        args.after_creation_time === undefined
          ? q.eq(q.field("_id"), q.field("_id"))
          : q.gt(q.field("_creationTime"), args.after_creation_time!),
      )
      .order("asc")
      .take(args.limit);
    return rows.map((r) => ({
      _id: r._id,
      _creationTime: r._creationTime,
      image_url: r.image_url,
    }));
  },
});
