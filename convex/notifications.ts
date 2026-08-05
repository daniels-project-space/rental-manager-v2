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
import {
  MAX_NOTIFICATION_DELIVERY_ATTEMPTS,
  notificationAttemptDue,
  notificationRetryDelayMs,
} from "./lib/notification_events";

export const NOTIF_TYPES = ["booking_confirmed", "new_request", "renter_message"] as const;
export type NotifType = (typeof NOTIF_TYPES)[number];
export const PUSH_NOTIFICATION_MODES = ["all", "money_only"] as const;
export type PushNotificationMode = (typeof PUSH_NOTIFICATION_MODES)[number];

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
  let inserted = 0;
  for (const e of events) {
    // Type-aware dedup. renter_message events are ALREADY gated on a genuinely
    // new inserted message (upsertMessages only queues the latest NEW message per
    // thread, and a re-poll re-seeing a message is skipped), so a 24h window here
    // just silenced follow-up messages ("sometimes I get no notification for a
    // message"). Use a tiny window for those — only to guard an overlapping
    // re-poll double-firing the SAME message. Transition-based types
    // (new_request / booking_confirmed) keep the 24h window so a re-poll that
    // re-sees the same state can't double-send.
    const dedupeMs = e.type === "renter_message" ? 30 * 1000 : 24 * 60 * 60 * 1000;
    const recent = await ctx.db
      .query("notification_events")
      .withIndex("by_thread_type", (q) =>
        q.eq("thread_id", e.thread_id).eq("type", e.type),
      )
      .order("desc")
      .first();
    if (recent && now - recent.created_at < dedupeMs) continue;
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
    mode: v.optional(v.union(v.literal("all"), v.literal("money_only"))),
    user_agent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("push_subscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .first();
    if (existing) {
      const credentialsChanged = existing.p256dh !== args.p256dh || existing.auth !== args.auth;
      const modeChanged = args.mode !== undefined && existing.mode !== args.mode;
      const metadataChanged = existing.user_agent !== args.user_agent || modeChanged;
      const refreshDue = now - existing.last_seen_at >= 24 * 60 * 60 * 1000;
      if (credentialsChanged || metadataChanged || refreshDue) {
        await ctx.db.patch(existing._id, {
          p256dh: args.p256dh,
          auth: args.auth,
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          user_agent: args.user_agent,
          last_seen_at: now,
        });
      }
      if (credentialsChanged) {
        await ctx.scheduler.runAfter(0, internal.notifications_send.dispatchPending, {});
      }
      return {
        status: credentialsChanged || metadataChanged ? "updated" as const : "unchanged" as const,
        mode: args.mode ?? existing.mode ?? "all" as const,
      };
    }
    await ctx.db.insert("push_subscriptions", {
      endpoint: args.endpoint,
      p256dh: args.p256dh,
      auth: args.auth,
      mode: args.mode ?? "all",
      user_agent: args.user_agent,
      created_at: now,
      last_seen_at: now,
    });
    // A newly enabled toggle immediately retries any still-pending event.
    await ctx.scheduler.runAfter(0, internal.notifications_send.dispatchPending, {});
    return { status: "created" as const, mode: args.mode ?? "all" as const };
  },
});

export const setPushSubscriptionMode = mutation({
  args: {
    endpoint: v.string(),
    mode: v.union(v.literal("all"), v.literal("money_only")),
  },
  handler: async (ctx, { endpoint, mode }) => {
    const existing = await ctx.db
      .query("push_subscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .first();
    if (!existing) throw new Error("Enable phone notifications on this device first.");
    if (existing.mode !== mode) {
      await ctx.db.patch(existing._id, { mode, last_seen_at: Date.now() });
    }
    return { mode };
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

/**
 * Fire a test notification (bell "Send test" button). Inserts a one-off event
 * with a unique thread id (bypasses the dedupe) and dispatches it, so the
 * operator can confirm their phone actually receives a push after enabling.
 */
export const sendTestNotification = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    // Point the test at a REAL pending request so tapping it opens an actual
    // chat thread (demonstrates the deep link), falling back to the dashboard.
    const pending = await ctx.db
      .query("reservations")
      .withIndex("by_awaiting_owner_action", (q) =>
        q.eq("awaiting_owner_action", true),
      )
      .first();
    const url = pending?.hygglo_order_id
      ? `/?thread=${encodeURIComponent(pending.hygglo_order_id)}${pending.account_slug ? `&account=${encodeURIComponent(pending.account_slug)}` : ""}`
      : "/";
    await ctx.db.insert("notification_events", {
      type: "booking_confirmed",
      thread_id: `test-${now}`,
      title: "🎉 Money notification test",
      body: "Your confirmed-rental alerts are working.",
      url,
      created_at: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.notifications_send.dispatchPending,
      {},
    );
    return { ok: true as const };
  },
});

// ── Internal helpers for the "use node" dispatcher ────────────────────

export const getUndelivered = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"notification_events">[]> => {
    const now = Date.now();
    const rows = await ctx.db
      .query("notification_events")
      .withIndex("by_delivered", (q) => q.eq("delivered_at", undefined))
      .order("desc")
      .take(100);
    return rows.filter((event) => notificationAttemptDue(event, now)).slice(0, 50);
  },
});

export const getSubscriptions = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"push_subscriptions">[]> => {
    return await ctx.db.query("push_subscriptions").collect();
  },
});

export const markDelivered = internalMutation({
  args: {
    ids: v.array(v.id("notification_events")),
    // Per-event channel outcome (how many pushes landed / Telegram ok) so a
    // "delivered" event that reached NO channel is visible in the data.
    outcomes: v.optional(
      v.array(
        v.object({
          id: v.id("notification_events"),
          push_ok: v.number(),
          push_eligible: v.optional(v.number()),
          push_suppressed: v.optional(v.number()),
          telegram_ok: v.boolean(),
          telegram_eligible: v.optional(v.boolean()),
          telegram_suppressed: v.optional(v.boolean()),
        }),
      ),
    ),
  },
  handler: async (ctx, { ids, outcomes }) => {
    const now = Date.now();
    const byId = new Map((outcomes ?? []).map((o) => [o.id, o]));
    let delivered = 0;
    let retryable = 0;
    let exhausted = 0;
    let retryAfterMs: number | undefined;
    for (const id of ids) {
      const o = byId.get(id);
      const existing = await ctx.db.get(id);
      if (!existing) continue;
      const attempts = (existing.delivery_attempts ?? 0) + 1;
      const eligibleChannels = o
        ? (o.push_eligible ?? 0) + (o.telegram_eligible ? 1 : 0)
        : 0;
      const suppressedChannels = o
        ? (o.push_suppressed ?? 0) + (o.telegram_suppressed ? 1 : 0)
        : 0;
      const preferenceSuppressed = !!o &&
        eligibleChannels === 0 &&
        suppressedChannels > 0;
      const succeeded = !!o && (o.push_ok > 0 || o.telegram_ok || preferenceSuppressed);
      await ctx.db.patch(id, {
        ...(succeeded ? { delivered_at: now } : {}),
        delivery_attempts: attempts,
        last_attempt_at: now,
        ...(!succeeded && attempts >= MAX_NOTIFICATION_DELIVERY_ATTEMPTS
          ? { delivery_exhausted_at: now }
          : {}),
        ...(o ? {
          push_ok: o.push_ok,
          push_eligible: o.push_eligible ?? 0,
          push_suppressed: o.push_suppressed ?? 0,
          telegram_ok: o.telegram_ok,
          telegram_eligible: o.telegram_eligible ?? false,
          telegram_suppressed: o.telegram_suppressed ?? false,
        } : {}),
      });
      if (succeeded) delivered++;
      else if (attempts >= MAX_NOTIFICATION_DELIVERY_ATTEMPTS) exhausted++;
      else {
        retryable++;
        const delay = notificationRetryDelayMs(attempts);
        retryAfterMs = retryAfterMs === undefined ? delay : Math.min(retryAfterMs, delay);
      }
    }
    return { delivered, retryable, exhausted, retryAfterMs };
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
