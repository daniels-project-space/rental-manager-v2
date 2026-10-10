import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
export const begin = internalMutation({
  args: { thread_id: v.string(), request_id: v.string(), snapshot: v.string() },
  handler: async (ctx, a) => {
    const prior = await ctx.db
      .query("quick_reply_swaps")
      .withIndex("by_request", (q) => q.eq("request_id", a.request_id))
      .unique();
    if (prior) {
      if (prior.thread_id !== a.thread_id || prior.snapshot !== a.snapshot)
        throw Error("Replacement request changed.");
      return { id: prior._id, state: prior.state };
    }
    const latest = await ctx.db
      .query("quick_reply_swaps")
      .withIndex("by_thread", (q) => q.eq("thread_id", a.thread_id))
      .order("desc")
      .first();
    if (latest && ["running", "attention"].includes(latest.state))
      throw Error(
        "A replacement is already running or needs an operator check on Hygglo.",
      );
    const id = await ctx.db.insert("quick_reply_swaps", {
      ...a,
      state: "running",
      at: Date.now(),
    });
    return { id, state: "new" };
  },
});
export const finish = internalMutation({
  args: {
    id: v.id("quick_reply_swaps"),
    state: v.union(
      v.literal("applied"),
      v.literal("failed"),
      v.literal("attention"),
    ),
  },
  handler: async (ctx, a) => {
    await ctx.db.patch(a.id, { state: a.state });
  },
});

export const receipt = internalQuery({
  args: { request_id: v.string() },
  handler: async (ctx, a) =>
    await ctx.db
      .query("quick_reply_swaps")
      .withIndex("by_request", (q) => q.eq("request_id", a.request_id))
      .unique(),
});
