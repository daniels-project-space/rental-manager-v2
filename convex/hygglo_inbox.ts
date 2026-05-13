/**
 * Wave 4 — Hygglo raw-payload inbox.
 *
 * Two write paths supported, decided by `source`:
 *   - "convex_http": The current Trigger.dev `poll-hygglo-inbox` (which already
 *     writes directly into `reservations` / `hygglo_messages`) ALSO drops a
 *     snapshot here for replay/audit.
 *   - "vps_scraper": Future split — an external VPS Playwright worker POSTs
 *     batches; this mutation receives them.
 *
 * The Mastra workflow drains unprocessed rows on each cycle, runs AI decisions,
 * and marks them processed.
 *
 * Dedup: payloadHash. Same payload received twice is a no-op.
 */
import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { api } from "./_generated/api";

export const receiveBatch = mutation({
  args: {
    source: v.union(v.literal("vps_scraper"), v.literal("convex_http")),
    payloadHash: v.string(),
    payload: v.any(),
  },
  handler: async (ctx, { source, payloadHash, payload }) => {
    const dupe = await ctx.db
      .query("hygglo_inbox")
      .withIndex("by_payloadHash", (q) => q.eq("payloadHash", payloadHash))
      .first();
    if (dupe) return { inserted: false, reason: "dupe", id: dupe._id };

    const id = await ctx.db.insert("hygglo_inbox", {
      receivedAt: Date.now(),
      source,
      payloadHash,
      payload,
      processed: false,
    });
    return { inserted: true, id };
  },
});

export const listUnprocessed = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    return await ctx.db
      .query("hygglo_inbox")
      .withIndex("by_processed", (q) => q.eq("processed", false))
      .take(limit ?? 100);
  },
});

export const markProcessed = mutation({
  args: { ids: v.array(v.id("hygglo_inbox")) },
  handler: async (ctx, { ids }) => {
    let count = 0;
    for (const id of ids) {
      const row = await ctx.db.get(id);
      if (!row || row.processed) continue;
      await ctx.db.patch(id, { processed: true });
      count++;
    }
    return { processed: count };
  },
});

/**
 * HTTP-ingest action — for the future VPS-scraper split. The Trigger.dev
 * scraper currently writes reservations directly; this is a forward-compat
 * endpoint so a Playwright-on-VPS worker can post pre-fetched payloads
 * without owning Convex schema knowledge.
 *
 * Wraps `receiveBatch` mutation so HTTP callers can fire-and-forget.
 */
export const ingestVpsBatch = action({
  args: {
    payloadHash: v.string(),
    payload: v.any(),
  },
  handler: async (ctx, { payloadHash, payload }) => {
    return await ctx.runMutation(api.hygglo_inbox.receiveBatch, {
      source: "vps_scraper",
      payloadHash,
      payload,
    });
  },
});
