/**
 * renter_bot_probe (2026-07-03) — TEST-ONLY harness to run the REAL generateDraft
 * pipeline against synthetic dbcinema/leo inquiry threads, for the v1-vs-v2
 * question battery + validation. Threads use the `__probe__` prefix and are
 * removed by `cleanup`. Not referenced by any UI/cron.
 */
import { action, internalMutation, mutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";

// Exported so other modules (e.g. replyInbox.ts's getReplyQueue) can exclude
// probe/fixture threads from real UI surfaces without duplicating the string.
export const PREFIX = "__probe__";

export const seed = internalMutation({
  args: {
    thread_id: v.string(),
    account_slug: v.string(),
    stage: v.optional(v.string()),
    items: v.array(v.object({ name: v.string(), product_id: v.optional(v.number()) })),
    messages: v.array(v.object({ role: v.string(), text: v.string() })),
    /**
     * Seed a real CONFIRMED reservation for this thread.
     *
     * Without one the bot always reads the thread as an enquiry, because
     * confirmation comes from reservations.status — not the conversation
     * stage. That made an arrival scenario ("I'm outside now") untestable:
     * the probe said CONFIRMED and the bot correctly answered "this request
     * hasn't been confirmed yet", so the test was measuring an incoherent
     * situation rather than a defect.
     */
    confirmed_booking: v.optional(
      v.object({ start_date: v.string(), end_date: v.string() }),
    ),
  },
  handler: async (ctx, { thread_id, account_slug, stage, items, messages, confirmed_booking }) => {
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
    // Clear any prior probe reservation for this thread, then seed if asked.
    for (const old of await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", thread_id))
      .collect())
      await ctx.db.delete(old._id);
    if (confirmed_booking) {
      await ctx.db.insert("reservations", {
        hygglo_order_id: thread_id,
        account_slug,
        status: "confirmed",
        renter_name: "Probe Renter",
        start_date: confirmed_booking.start_date,
        end_date: confirmed_booking.end_date,
        items: items.map((i) => ({ item_name: i.name, qty: 1 })),
        created_at: now,
      });
    }
    return { thread_id };
  },
});

export const run = action({
  args: {
    thread_id: v.string(),
    account_slug: v.string(),
    stage: v.optional(v.string()),
    items: v.array(v.object({ name: v.string(), product_id: v.optional(v.number()) })),
    messages: v.array(v.object({ role: v.string(), text: v.string() })),
    confirmed_booking: v.optional(
      v.object({ start_date: v.string(), end_date: v.string() }),
    ),
  },
  handler: async (ctx, a): Promise<{ draft?: string; confidence?: number; flags?: unknown }> => {
    await ctx.runMutation(internal.renter_bot_probe.seed, a);
    const r = await ctx.runAction(api.replyInbox_actions.generateDraft, {
      thread_id: a.thread_id,
    });
    return { draft: r.draft, confidence: r.confidence, flags: r.flags };
  },
});

/**
 * Mirrors sendRenterReply's on-send trigger EXACTLY (schedule the analyzer),
 * without hitting Hygglo — so the automatic + immediate learning path can be
 * validated. Returns instantly; the lesson is written by the scheduled action.
 */
export const simulateSend = action({
  args: {
    thread_id: v.string(),
    account_slug: v.optional(v.string()),
    sent_text: v.string(),
    draft_text: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<{ scheduled: true }> => {
    await ctx.scheduler.runAfter(0, internal.draft_learning_actions.analyzeDivergence, {
      thread_id: a.thread_id,
      account_slug: a.account_slug,
      sent_text: a.sent_text,
      draft_text: a.draft_text,
    });
    return { scheduled: true };
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
      // generateDraft caches its output in renter_bot_drafts (keyed by
      // thread_id) — that must be swept too, or a probe run leaves a
      // phantom draft behind after its conversation/messages are gone.
      for (const d of await ctx.db
        .query("renter_bot_drafts")
        .withIndex("by_thread", (q) => q.eq("thread_id", c.thread_id))
        .collect())
        await ctx.db.delete(d._id);
      await ctx.db.delete(c._id);
      n++;
    }
    for (const r of await ctx.db.query("reservations").collect())
      if (r.hygglo_order_id?.startsWith(PREFIX)) await ctx.db.delete(r._id);
    return { removed: n };
  },
});
