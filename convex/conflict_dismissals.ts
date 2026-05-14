/**
 * Conflict dismissals — owner-driven suppression for double-booking alerts.
 *
 * The conflict_key is a stable hash of `item_id|sorted(reservation_ids)`.
 * If the reservation set shifts (new booking joins, one cancels), the
 * dismissal no longer matches and the conflict re-surfaces.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const dismissConflict = mutation({
  args: {
    conflict_key: v.string(),
    item_id: v.id("items"),
    reservation_ids: v.array(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Idempotent: if already dismissed, just update the timestamp.
    const existing = await ctx.db
      .query("conflict_dismissals")
      .withIndex("by_key", (q) => q.eq("conflict_key", args.conflict_key))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { dismissed_at: Date.now(), note: args.note });
      return { ok: true, action: "updated" };
    }
    await ctx.db.insert("conflict_dismissals", {
      conflict_key: args.conflict_key,
      item_id: args.item_id,
      reservation_ids: args.reservation_ids,
      note: args.note,
      dismissed_at: Date.now(),
    });
    return { ok: true, action: "inserted" };
  },
});

export const clearConflictDismissal = mutation({
  args: { conflict_key: v.string() },
  handler: async (ctx, { conflict_key }) => {
    const existing = await ctx.db
      .query("conflict_dismissals")
      .withIndex("by_key", (q) => q.eq("conflict_key", conflict_key))
      .first();
    if (existing) await ctx.db.delete(existing._id);
    return { ok: true };
  },
});

export const listDismissedKeys = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("conflict_dismissals").collect();
    return all.map((r) => r.conflict_key);
  },
});
