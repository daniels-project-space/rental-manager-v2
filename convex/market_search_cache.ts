/**
 * Cache table for market_search action (24h TTL).
 * Kept in a separate non-node module because the action ("use node") can't
 * directly host queries/mutations.
 */
import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";

export const getCached = internalQuery({
  args: { query_norm: v.string() },
  handler: async (ctx, { query_norm }) => {
    const row = await ctx.db
      .query("market_search_cache")
      .withIndex("by_query_norm", (q) => q.eq("query_norm", query_norm))
      .first();
    if (!row) return null;
    if (row.expires_at < Date.now()) return null;
    return { result_json: row.result_json };
  },
});

export const setCached = internalMutation({
  args: {
    query_norm: v.string(),
    result_json: v.string(),
    ttl_ms: v.number(),
  },
  handler: async (ctx, { query_norm, result_json, ttl_ms }) => {
    const existing = await ctx.db
      .query("market_search_cache")
      .withIndex("by_query_norm", (q) => q.eq("query_norm", query_norm))
      .first();
    const now = Date.now();
    const payload = {
      query_norm,
      result_json,
      fetched_at: now,
      expires_at: now + ttl_ms,
    };
    if (existing) {
      await ctx.db.patch(existing._id, payload);
    } else {
      await ctx.db.insert("market_search_cache", payload);
    }
    return { ok: true };
  },
});
