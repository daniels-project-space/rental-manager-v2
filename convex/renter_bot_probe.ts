/**
 * renter_bot_probe (2026-07-03) — TEST-ONLY harness to run the REAL generateDraft
 * pipeline against synthetic dbcinema/leo inquiry threads, for the v1-vs-v2
 * question battery + validation. Threads use the `__probe__` prefix and are
 * removed by `cleanup`. Not referenced by any UI/cron.
 */
import { action, internalMutation, mutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";

const PREFIX = "__probe__";

export const seed = internalMutation({
  args: {
    thread_id: v.string(),
    account_slug: v.string(),
    stage: v.optional(v.string()),
    items: v.array(v.object({ name: v.string(), product_id: v.number() })),
    messages: v.array(v.object({ role: v.string(), text: v.string() })),
  },
  handler: async (ctx, { thread_id, account_slug, stage, items, messages }) => {
    const acc = (await ctx.db.query("accounts").collect()).find(
      (a) => a.slug === account_slug,
    );
    // wipe any prior probe rows for this thread
    for (const m of await ctx.db
      .query("hygglo_messages")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .collect())
      await ctx.db.delete(m._id);
    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .first();
    if (existing) await ctx.db.delete(existing._id);

    const now = Date.now();
    const STAGES = ["INQUIRY", "INTERESTED", "READY_TO_BOOK", "BOOKED", "CONFIRMED", "COMPLETED", "DEAD"] as const;
    const cs = stage && (STAGES as readonly string[]).includes(stage)
      ? (stage as (typeof STAGES)[number])
      : undefined;
    await ctx.db.insert("conversations", {
      thread_id,
      account_id: acc?._id,
      account_slug,
      last_msg_at: now,
      last_sender: "renter",
      last_renter_msg_at: now,
      created_at: now,
      conversation_stage: cs,
      inquiry_items: items.map((i) => ({ name: i.name, qty: 1, product_id: i.product_id })),
    });
    let i = 0;
    for (const msg of messages) {
      await ctx.db.insert("hygglo_messages", {
        account_slug,
        thread_id,
        message_id: `${thread_id}-m${i}`,
        sender: msg.role === "owner" ? "owner" : "renter",
        sender_name: msg.role === "owner" ? "Owner" : "DB Cinema Rentals",
        body_text: msg.text,
        hygglo_sent_at: now - (messages.length - i) * 60000,
        fetched_at: now,
      });
      i++;
    }
    return { thread_id };
  },
});

export const run = action({
  args: {
    thread_id: v.string(),
    account_slug: v.string(),
    stage: v.optional(v.string()),
    items: v.array(v.object({ name: v.string(), product_id: v.number() })),
    messages: v.array(v.object({ role: v.string(), text: v.string() })),
  },
  handler: async (ctx, a): Promise<{ draft?: string; confidence?: number; flags?: unknown }> => {
    await ctx.runMutation(internal.renter_bot_probe.seed, a);
    const r = await ctx.runAction(api.replyInbox_actions.generateDraft, {
      thread_id: a.thread_id,
    });
    return { draft: r.draft, confidence: r.confidence, flags: r.flags };
  },
});

export const cleanup = mutation({
  args: {},
  handler: async (ctx) => {
    let n = 0;
    const convs = (await ctx.db.query("conversations").collect()).filter((c) =>
      c.thread_id.startsWith(PREFIX),
    );
    for (const c of convs) {
      for (const m of await ctx.db
        .query("hygglo_messages")
        .withIndex("by_thread", (q) => q.eq("thread_id", c.thread_id))
        .collect())
        await ctx.db.delete(m._id);
      await ctx.db.delete(c._id);
      n++;
    }
    return { removed: n };
  },
});
