import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

const stringArray = v.array(v.string());

export const getLayout = query({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const row = await ctx.db
      .query("dashboardLayouts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return row;
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
    const existing = await ctx.db
      .query("dashboardLayouts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
      return existing._id;
    }
    return await ctx.db.insert("dashboardLayouts", {
      userId,
      panelOrder: patch.panelOrder ?? [],
      hiddenPanels: patch.hiddenPanels ?? [],
      statOrder: patch.statOrder ?? [],
      hiddenStats: patch.hiddenStats ?? [],
      updatedAt: now,
    });
  },
});

export const resetLayout = mutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const existing = await ctx.db
      .query("dashboardLayouts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
