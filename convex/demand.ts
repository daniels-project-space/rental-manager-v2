/**
 * Wave 2 — demand-signal read queries.
 *
 * V1 `demand_records` table doesn't exist in V2 yet (Wave 2.5 scope). For
 * now we proxy "top requested items" from `denial_records` grouped by
 * item_name within a lookback window. When a real `demand_records` table
 * lands, swap this implementation while keeping the wire shape stable.
 */
import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Aggregate denial_records by item_name within the last N days.
 * Returns descending by request count.
 */
export const getTopRequestedItems = query({
  args: {
    days: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { days, limit }) => {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const denials = await ctx.db.query("denial_records").collect();
    const recent = denials.filter((d) => d.created_at >= cutoff);
    const byItem = new Map<
      string,
      { itemName: string; requestCount: number; lastRequestedAt: number }
    >();
    for (const d of recent) {
      const key = (d.item_name ?? "").trim();
      if (!key) continue;
      const existing = byItem.get(key) ?? {
        itemName: key,
        requestCount: 0,
        lastRequestedAt: 0,
      };
      existing.requestCount += 1;
      if (d.created_at > existing.lastRequestedAt)
        existing.lastRequestedAt = d.created_at;
      byItem.set(key, existing);
    }
    const sorted = Array.from(byItem.values()).sort(
      (a, b) => b.requestCount - a.requestCount,
    );
    const take = limit ?? 20;
    return {
      days,
      totalDenials: recent.length,
      items: sorted.slice(0, take),
    };
  },
});
