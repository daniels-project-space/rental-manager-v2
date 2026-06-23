/**
 * Web-push / notification plumbing (2026-06-23).
 *
 * Queries + mutations only (V8 runtime). The actual push delivery lives in
 * `notifications_send.ts` ("use node" — web-push needs Node crypto).
 *
 * Flow:
 *   poller upsert detects a transition (new confirmed booking / new request)
 *     → queueNotificationEvents() inserts a `notification_events` row (deduped)
 *       and schedules internal.notifications_send.dispatchPending
 *         → web-push to every subscription + Telegram to Daniel, marks delivered.
 *
 * The dashboard bell calls getVapidPublicKey + savePushSubscription to opt in,
 * and listRecent / markAllRead to render the dropdown + unread badge.
 *
 * Convex prod env (npx convex env set):
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:…)
 *   NOTIF_BASE_URL (optional, defaults to the prod alias)
 */
import { v } from "convex/values";
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

export const NOTIF_TYPES = ["booking_confirmed", "new_request"] as const;
export type NotifType = (typeof NOTIF_TYPES)[number];

export interface NotifEventInput {
  type: NotifType;
  thread_id: string;
  account_slug?: string;
  title: string;
  body: string;
  url: string;
}

/**
 * Insert notification events (deduped) and schedule delivery. Called from the
 * poller's batch upsert (a mutation), so it takes a MutationCtx and runs inline
 * — no cross-mutation hop. De-dupe: skip a (thread_id, type) we already fired in
 * the last 24h, so a re-poll that re-sees the same transition can't double-send.
 */
export async function queueNotificationEvents(
  ctx: MutationCtx,
  events: NotifEventInput[],
): Promise<number> {
  if (events.length === 0) return 0;
  const now = Date.now();
  const DEDUPE_MS = 24 * 60 * 60 * 1000;
  let inserted = 0;
  for (const e of events) {
    const recent = await ctx.db
      .query("notification_events")
      .withIndex("by_thread_type", (q) =>
        q.eq("thread_id", e.thread_id).eq("type", e.type),
      )
      .order("desc")
      .first();
    if (recent && now - recent.created_at < DEDUPE_MS) continue;
    await ctx.db.insert("notification_events", {
      type: e.type,
      thread_id: e.thread_id,
      account_slug: e.account_slug,
      title: e.title,
      body: e.body,
      url: e.url,
      created_at: now,
    });
    inserted++;
  }
  if (inserted > 0) {
    await ctx.scheduler.runAfter(
      0,
      internal.notifications_send.dispatchPending,
      {},
    );
  }
  return inserted;
}

// ── Bell: VAPID key + subscription management ─────────────────────────

export const getVapidPublicKey = query({
  args: {},
  handler: async (): Promise<string | null> => {
    return process.env.VAPID_PUBLIC_KEY ?? null;
  },
});

export const savePushSubscription = mutation({
  args: {
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    user_agent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("push_subscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        p256dh: args.p256dh,
        auth: args.auth,
        user_agent: args.user_agent,
        last_seen_at: now,
      });
      return { status: "updated" as const };
    }
    await ctx.db.insert("push_subscriptions", {
      endpoint: args.endpoint,
      p256dh: args.p256dh,
      auth: args.auth,
      user_agent: args.user_agent,
      created_at: now,
      last_seen_at: now,
    });
    return { status: "created" as const };
  },
});

export const removePushSubscription = mutation({
  args: { endpoint: v.string() },
  handler: async (ctx, { endpoint }) => {
    const existing = await ctx.db
      .query("push_subscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .first();
    if (existing) await ctx.db.delete(existing._id);
    return { status: "ok" as const };
  },
});

// ── Bell: recent notifications + unread badge ─────────────────────────

export const listRecent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 20 }) => {
    const events = await ctx.db
      .query("notification_events")
      .withIndex("by_created")
      .order("desc")
      .take(limit);
    const unread = events.filter((e) => e.read_at === undefined).length;
    return { events, unread };
  },
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const unread = await ctx.db
      .query("notification_events")
      .withIndex("by_created")
      .order("desc")
      .take(100);
    let n = 0;
    for (const e of unread) {
      if (e.read_at === undefined) {
        await ctx.db.patch(e._id, { read_at: now });
        n++;
      }
    }
    return { marked: n };
  },
});

// ── Internal helpers for the "use node" dispatcher ────────────────────

export const getUndelivered = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"notification_events">[]> => {
    return await ctx.db
      .query("notification_events")
      .withIndex("by_delivered", (q) => q.eq("delivered_at", undefined))
      .take(50);
  },
});

export const getSubscriptions = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"push_subscriptions">[]> => {
    return await ctx.db.query("push_subscriptions").collect();
  },
});

export const markDelivered = internalMutation({
  args: { ids: v.array(v.id("notification_events")) },
  handler: async (ctx, { ids }) => {
    const now = Date.now();
    for (const id of ids) await ctx.db.patch(id, { delivered_at: now });
  },
});

export const pruneSubscriptions = internalMutation({
  args: { endpoints: v.array(v.string()) },
  handler: async (ctx, { endpoints }) => {
    for (const endpoint of endpoints) {
      const row = await ctx.db
        .query("push_subscriptions")
        .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
        .first();
      if (row) await ctx.db.delete(row._id);
    }
  },
});

// Re-export the Id type usage so dataModel import isn't flagged unused.
export type NotificationEventId = Id<"notification_events">;
