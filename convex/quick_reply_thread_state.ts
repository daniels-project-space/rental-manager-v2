import { mutation, query } from "./owner_functions";
import { v } from "convex/values";

/** Bounded indexed preferences, shared by native and website conversations. */
export const getForThreads = query({
  args: { thread_ids: v.array(v.string()) },
  handler: async (ctx, { thread_ids }) => {
    if (thread_ids.length > 500) throw new Error("TOO_MANY_THREADS");
    return Object.fromEntries(await Promise.all([...new Set(thread_ids)].map(async thread_id => {
      const row = await ctx.db.query("quick_reply_thread_state").withIndex("by_thread", q => q.eq("thread_id", thread_id)).first();
      return [thread_id, row?.through_renter_msg_at ?? null];
    })));
  },
});

export const hide = mutation({
  args: { thread_id: v.string(), through_renter_msg_at: v.number(), reason: v.union(v.literal("dismissed"), v.literal("declined")) },
  handler: async (ctx, args) => {
    if (!args.thread_id.trim() || args.thread_id.length > 160 || !Number.isFinite(args.through_renter_msg_at) || args.through_renter_msg_at < 0 || args.through_renter_msg_at > Date.now() + 60_000) throw new Error("INVALID_THREAD_WATERMARK");
    const previous = await ctx.db.query("quick_reply_thread_state").withIndex("by_thread", q => q.eq("thread_id", args.thread_id)).first();
    const record = { ...args, through_renter_msg_at: Math.max(previous?.through_renter_msg_at ?? 0, args.through_renter_msg_at), updated_at: Date.now() };
    if (previous) await ctx.db.patch(previous._id, record);
    else await ctx.db.insert("quick_reply_thread_state", record);
    return { ok: true };
  },
});
