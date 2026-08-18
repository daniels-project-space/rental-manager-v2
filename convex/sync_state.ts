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
    kind: v.optional(v.union(v.literal("run"), v.literal("heartbeat"))),
    // Phase 31 (Wave 8 cost opt) — adaptive polling backoff counter. Only
    // poll-hygglo.ts (source="hygglo_poller") passes this. Omitted by other
    // callers (catalog-sync, competitor-intel-sync) — see the conditional
    // spread below, which leaves any existing stored value untouched when
    // this argument isn't supplied, rather than clearing it.
    quietStreak: v.optional(v.number()),
  },
  handler: async (ctx, { source, succeeded, durationMs, rowsUpserted, errorMessage, kind, quietStreak }): Promise<void> => {
    const existing = await ctx.db
      .query("sync_state")
      .withIndex("by_source", (q) => q.eq("source", source))
      .first();

    const effectiveKind = kind ?? "run";

    // For heartbeats: only stamp liveness; do not advance counters/duration.
    if (effectiveKind === "heartbeat") {
      const hbFields = {
        source,
        lastRunAt: Date.now(),
        lastRunSucceeded: true,
        kind: effectiveKind,
      };
      if (existing) {
        await ctx.db.patch(existing._id, hbFields);
      } else {
        await ctx.db.insert("sync_state", hbFields);
      }
      return;
    }

    const fields = {
      source,
      lastRunAt: Date.now(),
      lastRunSucceeded: succeeded,
      durationMs,
      rowsUpserted,
      errorMessage,
      kind: effectiveKind,
      // Only patch quietStreak when the caller explicitly supplied it —
      // Convex patch() treats an `undefined` key as "clear this field", so
      // an unconditional include would wipe the counter on every call from
      // a source that doesn't know about it.
      ...(quietStreak !== undefined ? { quietStreak } : {}),
    };

    if (existing) {
      await ctx.db.patch(existing._id, fields);
    } else {
      await ctx.db.insert("sync_state", fields);
    }
  },
});
