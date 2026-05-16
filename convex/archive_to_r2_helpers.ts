/**
 * Phase 3a / Wave 3a — Convex DB helpers for the archive_to_r2 action.
 *
 * Split from `archive_to_r2.ts` because Convex disallows `internalMutation`
 * / `internalQuery` definitions in files marked with the `"use node";`
 * directive (Node.js runtime is action-only). The Node-runtime action
 * `runMutation`/`runQuery`s these helpers via the generated `internal` API.
 *
 * NO `"use node";` directive in this file.
 */
import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

/**
 * Page over old rows by `_creationTime` ascending. Returns chunk plus the
 * next cursor (the `_creationTime` of the last row, or null when drained).
 * Uses Convex's default `by_creation_time` index.
 */
export const listOldChunk = internalQuery({
  args: {
    table: v.union(v.literal("hygglo_messages"), v.literal("audit_log")),
    cutoffMs: v.number(),
    cursorMs: v.optional(v.number()),
    chunkSize: v.number(),
  },
  handler: async (
    ctx,
    { table, cutoffMs, cursorMs, chunkSize },
  ): Promise<{
    rows: Array<Record<string, unknown> & { _id: string; _creationTime: number }>;
    nextCursorMs: number | null;
  }> => {
    // We have to satisfy two predicates: `_creationTime < cutoffMs` and
    // (when paging) `_creationTime > cursorMs`. The built-in index works
    // for both.
    const rows = await ctx.db
      .query(table)
      .withIndex("by_creation_time", (q) =>
        cursorMs !== undefined
          ? q.gt("_creationTime", cursorMs).lt("_creationTime", cutoffMs)
          : q.lt("_creationTime", cutoffMs),
      )
      .order("asc")
      .take(chunkSize);
    if (rows.length === 0) return { rows: [], nextCursorMs: null };
    const lastRow = rows[rows.length - 1]!;
    const nextCursorMs: number | null =
      rows.length < chunkSize ? null : lastRow._creationTime;
    return {
      rows: rows as Array<
        Record<string, unknown> & { _id: string; _creationTime: number }
      >,
      nextCursorMs,
    };
  },
});

/**
 * Bulk-delete rows by id. Runs after a successful R2 PUT to free hot
 * storage. NEVER call this without verifying the R2 key landed first.
 */
export const deleteChunk = internalMutation({
  args: {
    table: v.union(v.literal("hygglo_messages"), v.literal("audit_log")),
    ids: v.array(v.string()),
  },
  handler: async (ctx, { table, ids }) => {
    let deleted = 0;
    for (const rawId of ids) {
      const id = rawId as Id<typeof table>;
      const doc = await ctx.db.get(id);
      if (!doc) continue; // already gone (e.g. retried run)
      await ctx.db.delete(id);
      deleted++;
    }
    return { deleted };
  },
});

// Helper query for the getMessagesIncludingArchive action. Returns
// hygglo_messages in the requested ms window, optionally filtered by
// account. Range scan via the by_creation_time index keeps it cheap.
export const listRangeForReader = internalQuery({
  args: {
    table: v.union(v.literal("hygglo_messages"), v.literal("audit_log")),
    fromMs: v.number(),
    toMs: v.number(),
    accountSlug: v.optional(v.string()),
  },
  handler: async (ctx, { table, fromMs, toMs, accountSlug }) => {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_creation_time", (q) =>
        q.gte("_creationTime", fromMs).lte("_creationTime", toMs),
      )
      .order("asc")
      .collect();
    if (!accountSlug || table === "audit_log") return rows;
    return rows.filter(
      (r) => (r as { account_slug?: string }).account_slug === accountSlug,
    );
  },
});
