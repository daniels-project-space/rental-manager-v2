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

// ── Reservation upsert ────────────────────────────────────────

const orderItemArgs = v.object({
  item_name: v.string(),
  qty: v.optional(v.number()),
});

/**
 * Internal mutation called by poll-hygglo-inbox after each order fetch.
 * Upserts a reservation row keyed by hygglo_order_id.
 * Does NOT overwrite rows that have v1_rental_id set (historical imports stay authoritative).
 */
export const upsertOrderAsReservation = mutation({
  args: {
    account_slug: v.string(),
    hygglo_order_id: v.string(),
    status: v.string(),
    start_date: v.string(),
    end_date: v.string(),
    gross_paid_gbp: v.optional(v.number()),
    net_to_owner_gbp: v.optional(v.number()),
    currency: v.optional(v.string()),
    items: v.array(orderItemArgs),
    duration_days: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ action: "inserted" | "updated" | "skipped" }> => {
    const existing = await ctx.db
      .query("reservations")
      .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", args.hygglo_order_id))
      .first();

    const now = Date.now();
    const fields = {
      account_slug: args.account_slug,
      hygglo_order_id: args.hygglo_order_id,
      status: args.status,
      start_date: args.start_date,
      end_date: args.end_date,
      gross_paid_gbp: args.gross_paid_gbp,
      net_to_owner_gbp: args.net_to_owner_gbp,
      currency: args.currency,
      items: args.items,
      duration_days: args.duration_days,
    };

    if (existing) {
      // Skip rows with v1_rental_id — historical import is authoritative.
      if (existing.v1_rental_id) return { action: "skipped" };
      await ctx.db.patch(existing._id, fields);
      return { action: "updated" };
    }

    await ctx.db.insert("reservations", {
      ...fields,
      created_at: now,
    });
    return { action: "inserted" };
  },
});
