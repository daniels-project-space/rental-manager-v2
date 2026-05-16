"use node";

/**
 * Phase 3c / Wave 3b — one-shot backfill for `item_image_phash`.
 *
 * Walks the `items` table; for each item with an `image_url`, downloads
 * the image, computes its pHash, and writes a row into
 * `item_image_phash` (source: "backfill"). Idempotent — skips items
 * whose image_url already has a phash row (by image_url).
 *
 * Manual invoke only (no cron). Chunked to stay inside Convex action
 * budgets:
 *
 *   npx convex run migrations/backfill_phash:backfillPhash \
 *     '{"chunkSize":15,"maxChunks":4}'
 *
 * Re-invoke as needed — already-done URLs cost only an index lookup.
 *
 * GRACEFUL DEGRADATION: a failed image download / pHash compute logs a
 * warning and is skipped, never aborts the batch.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { computePHash } from "../resolve_item_from_image";

interface ItemRow {
  _id: Id<"items">;
  _creationTime: number;
  image_url?: string;
}

// _listItemsForPhashBackfill moved to ../resolve_item_from_image_data.ts
// (this module is "use node").

export const backfillPhash = internalAction({
  args: {
    chunkSize: v.optional(v.number()),
    maxChunks: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    items_scanned: number;
    phashed: number;
    skipped_no_url: number;
    skipped_already_cached: number;
    failed: number;
    chunks_run: number;
  }> => {
    const chunkSize = Math.max(1, Math.min(args.chunkSize ?? 15, 100));
    const maxChunks = Math.max(1, Math.min(args.maxChunks ?? 4, 50));

    let cursor: number | undefined = undefined;
    let itemsScanned = 0;
    let phashed = 0;
    let skippedNoUrl = 0;
    let skippedAlreadyCached = 0;
    let failed = 0;
    let chunksRun = 0;

    for (let i = 0; i < maxChunks; i++) {
      const batch: ItemRow[] = await ctx.runQuery(
        internal.resolve_item_from_image_data._listItemsForPhashBackfill,
        { after_creation_time: cursor, limit: chunkSize },
      );
      if (batch.length === 0) break;
      chunksRun++;

      for (const row of batch) {
        itemsScanned++;
        cursor = row._creationTime;
        if (!row.image_url) {
          skippedNoUrl++;
          continue;
        }
        // Idempotency check
        const existing = await ctx.runQuery(
          internal.resolve_item_from_image_data.findByImageUrl,
          { image_url: row.image_url },
        );
        if (existing) {
          skippedAlreadyCached++;
          continue;
        }
        // Download + hash
        try {
          const res = await fetch(row.image_url);
          if (!res.ok) {
            console.warn(
              `[backfill_phash] download ${res.status} for ${row.image_url}`,
            );
            failed++;
            continue;
          }
          const arr = await res.arrayBuffer();
          const phash = await computePHash(Buffer.from(arr));
          await ctx.runMutation(
            internal.resolve_item_from_image_data.upsertPhashCache,
            {
              image_url: row.image_url,
              phash,
              canonical_item_id: row._id,
              confidence: 1.0, // backfill from items.image_url is authoritative
              source: "backfill",
            },
          );
          phashed++;
        } catch (err) {
          console.warn(
            `[backfill_phash] failed for ${row.image_url}: ${String(err)}`,
          );
          failed++;
        }
      }

      if (batch.length < chunkSize) break;
    }

    return {
      items_scanned: itemsScanned,
      phashed,
      skipped_no_url: skippedNoUrl,
      skipped_already_cached: skippedAlreadyCached,
      failed,
      chunks_run: chunksRun,
    };
  },
});
