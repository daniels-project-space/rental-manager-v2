/**
 * MV: mv_reply_queue (2026-07-07)
 *
 * Wraps the reply-inbox queue (replyInbox.getReplyQueue) in a cache. The live
 * query was the single biggest Convex DB-bandwidth drain (~399 GB/mo): per run
 * it read a window of `conversations`, did an N+1 full fat-reservation read per
 * thread, ran loadAvailCtx's confirmed-reservations scan, and it re-ran on EVERY
 * poller write (every 5 min) × every open dashboard tab. Now the tile list is
 * computed at most once per ~5 min; the widget reads a single indexed row.
 *
 * Freshness model:
 *   • Poller-driven data (new renter messages / requests): a 5-min cron
 *     (crons.ts "refresh_reply_queue") refreshes with skip-when-clean — it only
 *     rebuilds when a conversation/message/reservation changed since the last
 *     build, so quiet/overnight ticks are ~free.
 *   • User actions (dismiss / send reply / approve / decline) change queue
 *     membership and must reflect instantly — those mutations schedule an
 *     immediate forced refresh (see the ctx.scheduler.runAfter kicks in
 *     replyInbox.ts + replyInbox_actions.ts). The frontend also optimistically
 *     hides acted-on tiles, so the ≤5-min cron lag is never user-visible.
 *
 * Only the variant matching the current `availability_include_pending` setting
 * is refreshed (that's the only one ever read): key "all" (off) / "all:pending"
 * (on). Cold MV → getReplyQueue falls back to the live assembly.
 *
 * Mirrors the mv/stats_drawer.ts wrap-and-cache pattern.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, query } from "../_generated/server";
import { api } from "../_generated/api";
import { anyApi } from "convex/server";
import {
  REPLY_MV_WITHIN_DAYS,
  REPLY_MV_MESSAGES_WITHIN_DAYS,
  REPLY_MV_LIMIT,
} from "../replyInbox";

export const refresh = internalAction({
  // `force` bypasses skip-when-clean (used by the user-action kicks so a
  // dismissal/send is reflected even when no poller data changed).
  args: { force: v.optional(v.boolean()) },
  handler: async (
    ctx,
    { force },
  ): Promise<{ ok: true; written: number; skipped: number; durationMs: number }> => {
    return await refreshAll(ctx, force ?? false);
  },
});

export async function refreshAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  force = false,
): Promise<{ ok: true; written: number; skipped: number; durationMs: number }> {
  const startedAt = Date.now();
  const incPending: boolean = await ctx.runQuery(
    anyApi.mv.reply_queue.currentIncludePending,
    {},
  );
  const key = incPending ? "all:pending" : "all";

  if (!force) {
    const prior = await ctx.runQuery(anyApi.mv.reply_queue.get, { account: key });
    const priorGen: number = prior?.generatedAt ?? 0;
    if (priorGen > 0) {
      const dirty: boolean = await ctx.runQuery(
        anyApi.mv.reply_queue.dirtySince,
        { sinceMs: priorGen },
      );
      if (!dirty) {
        return { ok: true, written: 0, skipped: 1, durationMs: Date.now() - startedAt };
      }
    }
  }

  // Run the live assembly once (accountSlug null → all tiles; high limit so the
  // stored list is never truncated before the reader slices per-account).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tiles: any = await ctx.runQuery(api.replyInbox.getReplyQueue, {
    accountSlug: undefined,
    limit: REPLY_MV_LIMIT,
    withinDays: REPLY_MV_WITHIN_DAYS,
    messagesWithinDays: REPLY_MV_MESSAGES_WITHIN_DAYS,
    includeFinished: false,
    includeMessages: true,
    includePending: incPending,
    _bypassMv: true,
  });
  await ctx.runMutation(anyApi.mv.reply_queue.write, {
    account: key,
    tiles,
    generatedAt: startedAt,
  });
  return { ok: true, written: 1, skipped: 0, durationMs: Date.now() - startedAt };
}

/** The single global setting that selects which variant is read/refreshed. */
export const currentIncludePending = query({
  args: {},
  handler: async (ctx): Promise<boolean> => {
    const s = await ctx.db.query("settings").first();
    return s?.availability_include_pending ?? false;
  },
});

export const write = internalMutation({
  args: { account: v.string(), tiles: v.any(), generatedAt: v.number() },
  handler: async (ctx, { account, tiles, generatedAt }) => {
    const existing = await ctx.db
      .query("mv_reply_queue")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { tiles, generatedAt });
    } else {
      await ctx.db.insert("mv_reply_queue", { account, tiles, generatedAt });
    }
    return { ok: true };
  },
});

/** Reader used by refreshAll's skip-check (the widget reads via getReplyQueue). */
export const get = query({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const key = account ?? "all";
    return await ctx.db
      .query("mv_reply_queue")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
  },
});

/**
 * Skip-when-clean probe. True if any reply-relevant table changed since the MV
 * was last built. Poller-driven changes bump conversations.last_msg_at (new
 * message), hygglo_messages.fetched_at, or reservations.last_polled_at; new
 * request rows land via _creationTime. User-action changes (dismiss/send/
 * approve/decline) are handled by explicit forced-refresh kicks, not this probe.
 * Four indexed `.first()` reads — no table scan.
 */
export const dirtySince = query({
  args: { sinceMs: v.number() },
  handler: async (ctx, { sinceMs }): Promise<boolean> => {
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_last_msg_at")
      .order("desc")
      .first();
    if (conv && (conv.last_msg_at ?? 0) > sinceMs) return true;

    const msg = await ctx.db
      .query("hygglo_messages")
      .withIndex("by_fetched")
      .order("desc")
      .first();
    if (msg && (msg.fetched_at ?? 0) > sinceMs) return true;

    const polled = await ctx.db
      .query("reservations")
      .withIndex("by_last_polled_at")
      .order("desc")
      .first();
    const polledStamp = (polled as { last_polled_at?: number } | null)?.last_polled_at;
    if (typeof polledStamp === "number" && polledStamp > sinceMs) return true;

    const created = await ctx.db
      .query("reservations")
      .withIndex("by_creation_time")
      .order("desc")
      .first();
    if (created && created._creationTime > sinceMs) return true;

    return false;
  },
});
