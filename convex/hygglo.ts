import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const messageArgs = v.array(
  v.object({
    thread_id: v.string(),
    message_id: v.string(),
    sender: v.string(),
    sender_name: v.optional(v.string()),
    body_text: v.string(),
    hygglo_sent_at: v.optional(v.number()),
    fetched_at: v.number(),
    raw: v.optional(v.string()),
  })
);

// ── Mutations ─────────────────────────────────────────────────

/**
 * Public mutation called by Trigger.dev via ConvexHttpClient.
 * Deduplicates by (thread_id, message_id) — safe to call repeatedly.
 */
export const upsertMessages = mutation({
  args: {
    account_slug: v.string(),
    messages: messageArgs,
  },
  handler: async (ctx, { account_slug, messages }): Promise<{ inserted: number; skipped: number }> => {
    let inserted = 0;
    let skipped = 0;
    for (const msg of messages) {
      const existing = await ctx.db
        .query("hygglo_messages")
        .withIndex("by_thread_and_message", (q) =>
          q.eq("thread_id", msg.thread_id).eq("message_id", msg.message_id)
        )
        .first();
      if (existing) {
        skipped++;
        continue;
      }
      await ctx.db.insert("hygglo_messages", {
        account_slug,
        thread_id: msg.thread_id,
        message_id: msg.message_id,
        sender: msg.sender,
        sender_name: msg.sender_name,
        body_text: msg.body_text,
        hygglo_sent_at: msg.hygglo_sent_at,
        fetched_at: msg.fetched_at,
        raw: msg.raw,
      });
      inserted++;
    }
    return { inserted, skipped };
  },
});

// ── Queries ───────────────────────────────────────────────────

/**
 * Return the most recent N messages, optionally filtered by account.
 * Ordered by hygglo_sent_at desc (most recent first).
 */
export const getRecentMessages = query({
  args: {
    accountSlug: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { accountSlug, limit = 15 }) => {
    let rows;
    if (accountSlug) {
      rows = await ctx.db
        .query("hygglo_messages")
        .withIndex("by_account", (q) => q.eq("account_slug", accountSlug))
        .order("desc")
        .take(limit);
    } else {
      rows = await ctx.db
        .query("hygglo_messages")
        .withIndex("by_fetched")
        .order("desc")
        .take(limit);
    }
    return rows.sort(
      (a, b) =>
        (b.hygglo_sent_at ?? b.fetched_at) - (a.hygglo_sent_at ?? a.fetched_at)
    );
  },
});
