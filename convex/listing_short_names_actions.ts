/**
 * Listing short-name derivation actions (2026-05-23).
 *
 * Pass 14a (2026-05-26): dropped "use node" + deleted the per-item deriver.
 * The original file existed to call the AI SDK; pass 9e (2026-05-25)
 * replaced the LLM with a pure regex extractor, and pass 14a moved the
 * regex inline into a V8 batch mutation (listing_short_names.ts:
 * upsertShortNamesBatch). The poll hot path now schedules ONE mutation
 * per cycle instead of ~750 deriveOne actions.
 *
 * Kept here as thin compatibility shims:
 *   - `deriveOne`: legacy single-item entrypoint, delegates to the batch
 *     mutation. No callers in repo as of 14a but exposed for one-off ops.
 *   - `backfillActive`: admin action that re-derives every active listing.
 *     Single batched mutation invocation; no per-row scheduler overhead.
 */

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Legacy single-item shim. Delegates to upsertShortNamesBatch so the
 * derivation logic + caching live in one place.
 */
export const deriveOne = internalAction({
  args: {
    account_slug: v.string(),
    product_id: v.number(),
    raw_title: v.string(),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, { account_slug, product_id, raw_title }): Promise<{
    status: "derived";
    short_name: null;
  }> => {
    await ctx.runMutation(internal.listing_short_names.upsertShortNamesBatch, {
      items: [{ account_slug, product_id, raw_title }],
    });
    return { status: "derived", short_name: null };
  },
});

/** Backfill short_names for every (account_slug, product_id) currently
 *  surfaced in active rentals. Pass 14a: switched from per-row action
 *  iteration (with 120ms sleeps for LLM rate-limiting that no longer
 *  applies — derivation is pure regex) to a single batched mutation. */
export const backfillActive = action({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }): Promise<{
    listings: number;
    derived: number;
    cached: number;
  }> => {
    void force;
    const tuples: Array<{ account_slug: string; product_id: number; raw_title: string }> =
      await ctx.runQuery(internal.listing_short_names.listActiveDistinctProducts, {});
    if (tuples.length === 0) {
      return { listings: 0, derived: 0, cached: 0 };
    }
    const result: { checked: number; derived: number; cached: number } =
      await ctx.runMutation(internal.listing_short_names.upsertShortNamesBatch, {
        items: tuples,
      });
    console.log(
      `[listing_short_names] backfill complete: listings=${tuples.length} derived=${result.derived} cached=${result.cached}`,
    );
    return {
      listings: tuples.length,
      derived: result.derived,
      cached: result.cached,
    };
  },
});
