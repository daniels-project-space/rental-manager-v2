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
import { internalAction, internalMutation, internalQuery, query } from "../owner_functions";
import { mergeReplyPartitions } from "../lib/reply_queue_partitions";
import { internal } from "../_generated/api";
import { anyApi } from "convex/server";
import { refreshHandoffsWidget } from "./widgets";
import {currentQuickReplyCache} from "../lib/quick_reply_cache";
import { readReplyQueueRow, storeReplyQueueTiles } from "../lib/reply_queue_storage";
import { canonicalCacheJson, cacheValueDigest } from "../lib/lossless_cache_codec";
import {
  REPLY_MV_WITHIN_DAYS,
  REPLY_MV_MESSAGES_WITHIN_DAYS,
  REPLY_MV_LIMIT,
} from "../replyInbox";

// Even with no new message, rebuild at least this often so Hygglo-side status
// changes (renter paid → confirmed, etc.) that arrive with no chat message still
// reconcile. Bounds the worst-case staleness of the status badge.
const REPLY_QUEUE_BACKSTOP_MS = 5 * 60 * 1000;

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
  // 2026-07-13: piggyback the imminent-handoffs widget row on this 5-min
  // cron (own cheap gates + content-skip inside). Failure is non-fatal to
  // the queue rebuild.
  try {
    await refreshHandoffsWidget(ctx, startedAt);
  } catch (err) {
    console.warn("[mv/reply_queue] handoffs widget refresh failed", String(err));
  }
  const incPending: boolean = await ctx.runQuery(
    anyApi.mv.reply_queue.currentIncludePending,
    {},
  );
  const key = incPending ? "all:pending" : "all";

  if (!force) {
    const prior = await ctx.runQuery(anyApi.mv.reply_queue.get, { account: key });
    const priorGen: number = prior?.generatedAt ?? 0;
    if (priorGen > 0) {
      const age = startedAt - priorGen;
      const dirty: boolean = await ctx.runQuery(
        anyApi.mv.reply_queue.dirtySince,
        { sinceMs: priorGen },
      );
      // Skip only when nothing genuinely new arrived AND the cache is still fresh
      // within the backstop window. This is what stops the every-5-min no-op
      // rebuilds (the poller re-stamps last_polled_at constantly, but that no
      // longer counts as dirty — see dirtySince).
      if (!dirty && age >= 0 && age < REPLY_QUEUE_BACKSTOP_MS && currentQuickReplyCache(prior?.tiles)) {
        return { ok: true, written: 0, skipped: 1, durationMs: Date.now() - startedAt };
      }
    }
  }

  // Each cohort needs account-specific tile assembly, but the query also reads
  // shared conversations, reservation indexes, availability and listing context.
  // Pass every live cohort in one query so the shared data is loaded only once;
  // row filtering still keeps account-specific tile assembly partitioned.
  const partitions:Array<string|null>=await ctx.runQuery(anyApi.mv.reply_queue.partitionAccounts,{});
  const part=await ctx.runQuery(internal.replyInbox.__service_getReplyQueue, {
    limit:REPLY_MV_LIMIT,withinDays:REPLY_MV_WITHIN_DAYS,messagesWithinDays:REPLY_MV_MESSAGES_WITHIN_DAYS,
    includeFinished:false,includeMessages:true,includePending:incPending,_bypassMv:true,_partitionSlugs:partitions,
  });
  // Keep deterministic deduplication and global ordering on the returned rows.
  const tiles=mergeReplyPartitions([part],REPLY_MV_LIMIT);
  await ctx.runMutation(anyApi.mv.reply_queue.write, {
    account: key,
    tiles,
    generatedAt: startedAt,
  });
  return { ok: true, written: 1, skipped: 0, durationMs: Date.now() - startedAt };
}

export const partitionAccounts=internalQuery({
  args:{},
  handler:async(ctx)=>{
    const accounts=await ctx.db.query("accounts").take(51);
    if(accounts.length===51)throw Error("Reply queue account partition exceeds its audited bound");
    return [...new Set(accounts.map(account=>account.slug)),null];
  },
});

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
      // Content-skip: a no-op patch still re-pushes the full (~200 KB) tiles row
      // to every subscribed dashboard tab (Convex reactivity fires on any write).
      // Only rewrite when the visible tile list actually changed. `existing` is
      // already read for the patch-vs-insert branch; decoding it needs no extra
      // database read. Encoding-only migration preserves its generation time.
      const logical = await readReplyQueueRow(existing);
      if (logical && canonicalCacheJson(logical.tiles) === canonicalCacheJson(tiles)) {
        if (existing.tiles !== null) {
          const packed = await storeReplyQueueTiles(account, existing.generatedAt, tiles);
          if (packed.tiles_gzip) await ctx.db.patch(existing._id, packed);
        }
        return { ok: true, skipped: true };
      }
      await ctx.db.patch(existing._id, { ...await storeReplyQueueTiles(account, generatedAt, tiles), generatedAt });
    } else {
      await ctx.db.insert("mv_reply_queue", { account, ...await storeReplyQueueTiles(account, generatedAt, tiles), generatedAt });
    }
    return { ok: true };
  },
});

/** Reader used by refreshAll's skip-check (the widget reads via getReplyQueue). */
export const get = query({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const key = account ?? "all";
    return await readReplyQueueRow(await ctx.db
      .query("mv_reply_queue")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first());
  },
});

/** Encoding-only migration: preserve the exact cached values and generation
 * time, and audit the complete logical row before changing its storage. */
export const repack = internalMutation({ args: { account: v.string() }, handler: async (ctx, { account }) => {
  const row = await ctx.db.query("mv_reply_queue").withIndex("by_account", q => q.eq("account", account)).first();
  const logical = await readReplyQueueRow(row);
  if (!row || !logical) return { packed: false, reason: "missing or invalid cache" };
  const packed = await storeReplyQueueTiles(account, row.generatedAt, logical.tiles);
  if (!packed.tiles_gzip) return { packed: false, reason: "legacy capacity fallback" };
  const decoded = await readReplyQueueRow({ ...row, ...packed });
  if (canonicalCacheJson(logical) !== canonicalCacheJson(decoded)) throw Error("Queue encoding audit failed");
  if (row.tiles !== null) await ctx.db.patch(row._id, packed);
  return { packed: true, bytes: row.tiles === null ? row.tiles_gzip!.byteLength : packed.tiles_gzip.byteLength, tiles: Array.isArray(logical.tiles) ? logical.tiles.length : 0,
    generatedAt: row.generatedAt, before_sha256: await cacheValueDigest(logical), after_sha256: await cacheValueDigest(decoded) };
} });

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
    // Detect GENUINE new activity via Convex `_creationTime` (real wall-clock,
    // assigned on insert, never re-stamped or future-dated). We deliberately do
    // NOT use the Hygglo-provided timestamps (conversations.last_msg_at,
    // hygglo_messages.fetched_at) — some of those are FUTURE-dated, so a
    // `max(...) > sinceMs` probe on them is permanently "dirty" and would never
    // skip. And NOT reservations.last_polled_at, which the poller re-stamps every
    // 5-min cycle even when nothing changed. Signals:
    //   • a new renter message  → a new hygglo_messages row (deduped by
    //     by_thread_and_message, so only genuinely-new messages insert)
    //   • a new reservation/request → a new reservations row
    //   • a brand-new thread    → a new conversations row
    // Hygglo-side status changes on EXISTING rows (no new message) are reconciled
    // by the age backstop in refreshAll + the dismiss/approve/decline event kicks.
    const msg = await ctx.db
      .query("hygglo_messages")
      .withIndex("by_creation_time")
      .order("desc")
      .first();
    if (msg && msg._creationTime > sinceMs) return true;

    const created = await ctx.db
      .query("reservations")
      .withIndex("by_creation_time")
      .order("desc")
      .first();
    if (created && created._creationTime > sinceMs) return true;

    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_creation_time")
      .order("desc")
      .first();
    if (conv && conv._creationTime > sinceMs) return true;

    return false;
  },
});
