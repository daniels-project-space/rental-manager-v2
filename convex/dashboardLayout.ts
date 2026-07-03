import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

const stringArray = v.array(v.string());

/**
 * Pick the canonical (newest) layout row for a user, tolerating accidental
 * duplicates. `updateLayout` was previously a non-atomic check-then-insert, so
 * two concurrent saves (rapid toggles, or a second tab) could create more than
 * one row for the same userId. `.unique()` THROWS on >1 row, which made
 * getLayout error → the edit-mode context fell back to DEFAULTS → EVERY widget
 * reappeared ("all widgets came back"). Reading tolerantly + healing on write
 * removes that failure mode entirely.
 */
function newest(rows: Doc<"dashboardLayouts">[]): Doc<"dashboardLayouts"> | null {
  if (rows.length === 0) return null;
  return rows.reduce((a, b) => ((b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a));
}

export const getLayout = query({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const rows = await ctx.db
      .query("dashboardLayouts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return newest(rows);
  },
});

export const updateLayout = mutation({
  args: {
    userId: v.string(),
    panelOrder: v.optional(stringArray),
    hiddenPanels: v.optional(stringArray),
    statOrder: v.optional(stringArray),
    hiddenStats: v.optional(stringArray),
  },
  handler: async (ctx, args) => {
    const { userId, ...patch } = args;
    const now = Date.now();
    const rows = await ctx.db
      .query("dashboardLayouts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    const primary = newest(rows);
    if (!primary) {
      return await ctx.db.insert("dashboardLayouts", {
        userId,
        panelOrder: patch.panelOrder ?? [],
        hiddenPanels: patch.hiddenPanels ?? [],
        statOrder: patch.statOrder ?? [],
        hiddenStats: patch.hiddenStats ?? [],
        updatedAt: now,
      });
    }
    // Self-heal: collapse any duplicate rows into the newest one so a past
    // race can never resurface as a `.unique()` crash → default layout.
    for (const r of rows) {
      if (r._id !== primary._id) await ctx.db.delete(r._id);
    }
    await ctx.db.patch(primary._id, { ...patch, updatedAt: now });
    return primary._id;
  },
});

export const resetLayout = mutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    // Delete ALL rows for the user (not `.unique()`, which would throw if a
    // duplicate ever slipped in and leave the layout un-resettable).
    const rows = await ctx.db
      .query("dashboardLayouts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
  },
});
