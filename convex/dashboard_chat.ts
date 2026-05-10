import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// ── Queries ────────────────────────────────────────────────────

export const getMessages = query({
  args: {
    thread_id: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const thread_id = args.thread_id ?? "dashboard";
    const limit = args.limit ?? 50;
    const rows = await ctx.db
      .query("dashboard_chat_messages")
      .withIndex("by_thread_and_time", (q) => q.eq("thread_id", thread_id))
      .order("asc")
      .take(limit);
    return rows;
  },
});

// ── Mutations ──────────────────────────────────────────────────

export const appendMessage = mutation({
  args: {
    thread_id: v.optional(v.string()),
    role: v.string(),
    content: v.string(),
    tool_name: v.optional(v.string()),
    tool_call_id: v.optional(v.string()),
    metadata: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const thread_id = args.thread_id ?? "dashboard";
    const id = await ctx.db.insert("dashboard_chat_messages", {
      thread_id,
      role: args.role,
      content: args.content,
      tool_name: args.tool_name,
      tool_call_id: args.tool_call_id,
      metadata: args.metadata,
      created_at: Date.now(),
    });
    return id;
  },
});

export const appendMessages = mutation({
  args: {
    thread_id: v.optional(v.string()),
    messages: v.array(
      v.object({
        role: v.string(),
        content: v.string(),
        tool_name: v.optional(v.string()),
        tool_call_id: v.optional(v.string()),
        metadata: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const thread_id = args.thread_id ?? "dashboard";
    const now = Date.now();
    const ids = [];
    for (let i = 0; i < args.messages.length; i++) {
      const m = args.messages[i];
      const id = await ctx.db.insert("dashboard_chat_messages", {
        thread_id,
        role: m.role,
        content: m.content,
        tool_name: m.tool_name,
        tool_call_id: m.tool_call_id,
        metadata: m.metadata,
        created_at: now + i,
      });
      ids.push(id);
    }
    return ids;
  },
});

export const clearThread = mutation({
  args: { thread_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const thread_id = args.thread_id ?? "dashboard";
    const rows = await ctx.db
      .query("dashboard_chat_messages")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .collect();
    await Promise.all(rows.map((r) => ctx.db.delete(r._id)));
    return { deleted: rows.length };
  },
});
