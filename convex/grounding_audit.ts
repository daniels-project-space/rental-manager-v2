/**
 * grounding_audit — measures how often a draft would actually be GROUNDED, i.e.
 * how many inquiry threads carry a resolvable product_id (which deterministically
 * yields real listing facts) vs a bare name the model has to guess about.
 * One-off diagnostic; safe read-only.
 */
import { internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const audit = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 300 }) => {
    const convs = await ctx.db.query("conversations").order("desc").take(limit);
    let withItems = 0;
    let convWithPid = 0;
    let totalItems = 0;
    let itemsWithPid = 0;
    const misses: string[] = [];
    for (const c of convs) {
      const items = (c.inquiry_items ?? []) as Array<{ name?: string; product_id?: number }>;
      if (!items.length) continue;
      withItems++;
      let anyPid = false;
      for (const it of items) {
        totalItems++;
        if (typeof it.product_id === "number") {
          itemsWithPid++;
          anyPid = true;
        }
      }
      if (anyPid) convWithPid++;
      else if (misses.length < 10)
        misses.push(items.map((i) => i.name ?? "?").join(" + "));
    }
    return {
      sampled: convs.length,
      threadsWithItems: withItems,
      threadsFullyGroundable: convWithPid,
      threadGroundedPct: withItems ? Math.round((convWithPid / withItems) * 100) : 0,
      totalInquiryItems: totalItems,
      itemsWithProductId: itemsWithPid,
      itemProductIdCoveragePct: totalItems ? Math.round((itemsWithPid / totalItems) * 100) : 0,
      ungroundedExamples: misses,
    };
  },
});
