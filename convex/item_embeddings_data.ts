/**
 * Phase 3c / Wave 3a — Convex vectorIndex data layer.
 *
 * Queries + mutations for item_embeddings table. Split out from
 * item_embeddings.ts because that file is "use node" (for the Gemini
 * SDK) and node-runtime Convex modules may only export actions.
 *
 * Callers: convex/item_embeddings.ts (actions reference these via
 * internal.item_embeddings_data.*).
 */

import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";

const EMBEDDING_MODEL = "text-embedding-004";

/**
 * Write a single embedding row. Replaces any existing row with the same
 * (item_id, source_kind) tuple to keep the table idempotent.
 */
export const upsertEmbedding = internalMutation({
  args: {
    item_id: v.id("items"),
    embedding: v.array(v.float64()),
    embedding_model: v.string(),
    source_kind: v.union(v.literal("name"), v.literal("description"), v.literal("image")),
    source_ref: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("item_embeddings")
      .withIndex("by_item_and_kind", (q) =>
        q.eq("item_id", args.item_id).eq("source_kind", args.source_kind),
      )
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        embedding: args.embedding,
        embedding_model: args.embedding_model,
        source_ref: args.source_ref,
        generated_at: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("item_embeddings", {
      item_id: args.item_id,
      embedding: args.embedding,
      embedding_model: args.embedding_model,
      source_kind: args.source_kind,
      source_ref: args.source_ref,
      generated_at: now,
    });
  },
});

/**
 * Returns true when (item_id, source_kind) is already embedded with the
 * current model. Backfill uses this to skip already-done rows.
 */
export const hasEmbedding = internalQuery({
  args: {
    item_id: v.id("items"),
    source_kind: v.union(v.literal("name"), v.literal("description"), v.literal("image")),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("item_embeddings")
      .withIndex("by_item_and_kind", (q) =>
        q.eq("item_id", args.item_id).eq("source_kind", args.source_kind),
      )
      .first();
    return !!row && row.embedding_model === EMBEDDING_MODEL;
  },
});

/**
 * Load a single item (used by generateEmbeddingsForItem to assemble the
 * three source strings).
 */
export const getItem = internalQuery({
  args: { item_id: v.id("items") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.item_id);
  },
});

/**
 * Paged list of items for backfill. Cursor-based via `_creationTime` for
 * stable ordering. Limit caps chunk size.
 */
export const listItemsForBackfill = internalQuery({
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
      name_canonical: r.name_canonical,
      name_input: r.name_input,
      image_url: r.image_url,
    }));
  },
});

/**
 * Side-table description lookup. Returns null when no spec exists.
 */
export const getItemSpec = internalQuery({
  args: { item_id: v.id("items") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("item_specs")
      .withIndex("by_item", (q) => q.eq("item_id", args.item_id))
      .first();
  },
});
