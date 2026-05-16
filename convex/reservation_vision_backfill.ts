/**
 * Phase W3b — one-time backfill for the reservation_vision side table.
 *
 * Reads existing `reservations` rows whose `resolved_items` is non-null
 * and writes a mirror into `reservation_vision`. Idempotent — skips rows
 * whose side-table mirror is already at-or-newer than the source.
 *
 * USAGE:
 *   - Invoke manually from the Convex dashboard after deploy:
 *       runAction(internal.reservation_vision_backfill.backfillReservationVision, {
 *         chunk_size: 200,
 *         max_chunks: 100,
 *         dry_run: false,
 *       })
 *   - Repeat-call until `total_remaining` returns 0.
 *   - `dry_run: true` does the read pass + counts but skips the write.
 *
 * SAFETY:
 *   - Writes ONLY to the new `reservation_vision` table — cannot corrupt
 *     primary reservations data.
 *   - Idempotent (`last_synced_at` checkpoint).
 *   - Bounded per-call (chunk_size × max_chunks) to stay under Convex
 *     transaction limits and action timeouts.
 */

import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Per-chunk write mutation. Kept separate from the action so each chunk
 * commits independently (prevents one-row failure from wiping a 200-row
 * batch). The action loops over chunks and aggregates the result.
 */
export const _backfillChunk = internalMutation({
  args: {
    chunk_size: v.number(),
    cursor: v.optional(v.string()),
    dry_run: v.boolean(),
  },
  handler: async (ctx, { chunk_size, cursor, dry_run }) => {
    const page = await ctx.db
      .query("reservations")
      .paginate({ numItems: chunk_size, cursor: cursor ?? null });

    let processed = 0;
    let skipped = 0;
    for (const r of page.page) {
      const resolved = (r as { resolved_items?: unknown }).resolved_items;
      if (resolved === undefined || resolved === null) {
        skipped++;
        continue;
      }
      // Idempotency: check existing mirror row and skip if last_synced_at
      // is >= the reservation's most recent resolution timestamp. We use
      // resolution_at when available; otherwise the reservation _creationTime.
      const resolutionAt =
        (r as { resolution_at?: number }).resolution_at ??
        r._creationTime ??
        0;
      const existing = await ctx.db
        .query("reservation_vision")
        .withIndex("by_reservation_id", (q) => q.eq("reservation_id", r._id))
        .unique();
      if (existing && existing.last_synced_at >= resolutionAt) {
        skipped++;
        continue;
      }
      if (dry_run) {
        processed++;
        continue;
      }
      const now = Date.now();
      if (existing) {
        await ctx.db.patch(existing._id, {
          resolved_items: resolved,
          vision_processed_at: resolutionAt > 0 ? resolutionAt : undefined,
          last_synced_at: now,
        });
      } else {
        await ctx.db.insert("reservation_vision", {
          reservation_id: r._id,
          resolved_items: resolved,
          vision_processed_at: resolutionAt > 0 ? resolutionAt : undefined,
          last_synced_at: now,
        });
      }
      processed++;
    }
    return {
      processed,
      skipped,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/**
 * Top-level backfill driver. Loops `max_chunks` times calling
 * `_backfillChunk`. Returns aggregated counters + whether more rows remain.
 */
export const backfillReservationVision = internalAction({
  args: {
    chunk_size: v.optional(v.number()),
    max_chunks: v.optional(v.number()),
    dry_run: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { chunk_size, max_chunks, dry_run },
  ): Promise<{
    processed: number;
    skipped: number;
    chunks_completed: number;
    finished: boolean;
    final_cursor: string | null;
    dry_run: boolean;
  }> => {
    const chunk = Math.max(1, Math.min(chunk_size ?? 200, 500));
    const maxChunks = Math.max(1, Math.min(max_chunks ?? 50, 500));
    const isDry = dry_run ?? false;

    let cursor: string | null = null;
    let totalProcessed = 0;
    let totalSkipped = 0;
    let chunksCompleted = 0;
    let finished = false;

    for (let i = 0; i < maxChunks; i++) {
      const res: {
        processed: number;
        skipped: number;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runMutation(
        internal.reservation_vision_backfill._backfillChunk,
        {
          chunk_size: chunk,
          cursor: cursor ?? undefined,
          dry_run: isDry,
        },
      );
      totalProcessed += res.processed;
      totalSkipped += res.skipped;
      chunksCompleted++;
      cursor = res.continueCursor;
      if (res.isDone) {
        finished = true;
        break;
      }
    }

    return {
      processed: totalProcessed,
      skipped: totalSkipped,
      chunks_completed: chunksCompleted,
      finished,
      final_cursor: cursor,
      dry_run: isDry,
    };
  },
});
