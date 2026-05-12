import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// ── Queries ───────────────────────────────────────────────────

/**
 * Returns the sync state row for a given source, or null if none exists.
 */
export const get = query({
  args: { source: v.string() },
  handler: async (ctx, { source }) => {
    return await ctx.db
      .query("sync_state")
      .withIndex("by_source", (q) => q.eq("source", source))
      .order("desc")
      .first();
  },
});

// ── Mutations ─────────────────────────────────────────────────

/**
 * Upserts a sync run record for the given source.
 * If a row already exists for that source, it is patched in place.
 * Otherwise a new row is inserted.
 */
export const recordSyncRun = mutation({
  args: {
    source: v.string(),
    succeeded: v.boolean(),
    durationMs: v.optional(v.number()),
    rowsUpserted: v.optional(v.object({
      reservations: v.optional(v.number()),
      hygglo_messages: v.optional(v.number()),
      renters: v.optional(v.number()),
      conversations: v.optional(v.number()),
    })),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, { source, succeeded, durationMs, rowsUpserted, errorMessage }): Promise<void> => {
    const existing = await ctx.db
      .query("sync_state")
      .withIndex("by_source", (q) => q.eq("source", source))
      .first();

    const fields = {
      source,
      lastRunAt: Date.now(),
      lastRunSucceeded: succeeded,
      durationMs,
      rowsUpserted,
      errorMessage,
    };

    if (existing) {
      await ctx.db.patch(existing._id, fields);
    } else {
      await ctx.db.insert("sync_state", fields);
    }
  },
});
