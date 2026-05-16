import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

/**
 * One-shot audit sweep: iterates every distinct Hygglo listing_id found in
 * the reservations table and runs it through the listing_resolver cascade.
 *
 * Design:
 *   - Cursor-based pagination via listDistinctListings (audit_listings_data)
 *   - Per-listing errors are collected, not thrown — the whole sweep never
 *     fails because one listing has bad data
 *   - Idempotent by default: listings already in listing_resolution with
 *     status="resolved" are skipped unless force=true
 *   - Account-scoped when `account` arg is given
 *
 * Invoke manually via Convex dashboard or a cron:
 *   ctx.scheduler.runAfter(0, internal.audit_listings.runAudit, {})
 */
export const runAudit = internalAction({
  args: {
    chunk_size: v.optional(v.number()),   // default 50
    max_chunks: v.optional(v.number()),   // default unlimited
    force: v.optional(v.boolean()),       // re-resolve already-resolved listings
    account: v.optional(v.string()),      // scope to one account if given
  },
  handler: async (ctx, args) => {
    const chunkSize = args.chunk_size ?? 50;
    const force = args.force ?? false;
    let chunksProcessed = 0;
    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalResolved = 0;
    let totalPendingReview = 0;
    const errors: Array<{ listing_id: string; error: string }> = [];

    // Stream distinct listings via a paginated query
    let cursor: string | null = null;
    while (true) {
      if (args.max_chunks !== undefined && chunksProcessed >= args.max_chunks) break;

      // Fetch next chunk of distinct listings.
      // Explicit type annotation breaks the circular-inference issue that arises
      // when _generated/api.d.ts hasn't been regenerated yet after adding the
      // new module. The shape must match listDistinctListings's return type.
      const chunk: {
        listings: Array<{
          hygglo_listing_id: string;
          hygglo_account: string;
          hygglo_title: string;
          hygglo_description: string | undefined;
          hygglo_detail_payload: unknown | undefined;
          image_url: string | undefined;
        }>;
        next_cursor: string | null;
      } = await ctx.runQuery(
        internal.audit_listings_data.listDistinctListings,
        {
          cursor,
          limit: chunkSize,
          account: args.account,
          skip_resolved: !force,
        },
      );

      if (chunk.listings.length === 0) break;

      for (const listing of chunk.listings) {
        try {
          const result = await ctx.runAction(
            internal.listing_resolver.resolveListing,
            {
              hygglo_listing_id: listing.hygglo_listing_id,
              hygglo_account: listing.hygglo_account,
              hygglo_title: listing.hygglo_title,
              hygglo_description: listing.hygglo_description,
              hygglo_detail_payload: listing.hygglo_detail_payload,
              image_url: listing.image_url,
            },
          );
          totalProcessed++;
          if (result.status === "pending_review") totalPendingReview++;
          else totalResolved++;
        } catch (err) {
          errors.push({
            listing_id: listing.hygglo_listing_id,
            error: String(err).slice(0, 200),
          });
        }
      }

      chunksProcessed++;
      cursor = chunk.next_cursor;
      if (!cursor) break;
    }

    return {
      chunks_processed: chunksProcessed,
      total_processed: totalProcessed,
      total_skipped: totalSkipped,
      total_resolved: totalResolved,
      total_pending_review: totalPendingReview,
      errors: errors.slice(0, 20), // surface first 20 errors
      error_count: errors.length,
    };
  },
});
