import { mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Records the complete set returned by Hygglo's `current` order filter.
 *
 * Call this only after a fully successful list + detail poll. Partial polls
 * must leave the previous known-good snapshot intact, otherwise a transient
 * upstream error could incorrectly hide an outstanding return.
 */
export const replaceCurrentOrders = mutation({
  args: {
    account: v.string(),
    orderIds: v.array(v.string()),
    observedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const orderIds = [...new Set(args.orderIds)].sort();
    const existing = await ctx.db
      .query("hygglo_current_order_presence")
      .withIndex("by_account", (q) => q.eq("account", args.account))
      .first();

    if (existing) {
      const unchanged =
        existing.orderIds.length === orderIds.length &&
        existing.orderIds.every((id, index) => id === orderIds[index]);
      // Membership is the ground truth Return Hub consumes. Avoid advancing a
      // heartbeat timestamp when the set is identical: that would invalidate
      // the reactive query and force a live rich-reservation scan every poll.
      if (unchanged) {
        return { action: "skipped", count: orderIds.length };
      }
      await ctx.db.patch(existing._id, {
        orderIds,
        observedAt: args.observedAt,
      });
      return { action: "updated", count: orderIds.length };
    }

    await ctx.db.insert("hygglo_current_order_presence", {
      account: args.account,
      orderIds,
      observedAt: args.observedAt,
    });
    return { action: "inserted", count: orderIds.length };
  },
});
