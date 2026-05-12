import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// ── Queries ───────────────────────────────────────────────────

/**
 * Returns the sync state row for a given source, or null if none exists.
 * NOTE: .order("desc") removed — it is only valid on the implicit _creationTime
 * ordering, but combining it with withIndex on a non-time field can throw on
 * some Convex versions when the table is empty. We use .first() which safely
 * returns null when no rows match, and wrap in try/catch for safety.
 */
export const get = query({
  args: { source: v.string() },
  handler: async (ctx, { source }) => {
    try {
      return await ctx.db
        .query("sync_state")
        .withIndex("by_source", (q) => q.eq("source", source))
        .first();
    } catch (err) {
      console.error("[sync_state.get] Unexpected error:", err);
      return null;
    }
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
