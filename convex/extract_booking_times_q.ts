/**
 * Internal queries/mutations for the booking-time extractor action.
 * Action runs in Node; these run in the Convex runtime.
 */

import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";

export const getReservationForExtract = internalQuery({
  args: { reservation_id: v.id("reservations") },
  handler: async (ctx, { reservation_id }) => {
    const r = await ctx.db.get(reservation_id);
    if (!r) return null;
    return {
      _id: r._id,
      hygglo_order_id: r.hygglo_order_id,
      start_date: r.start_date,
      end_date: r.end_date,
      items: r.items ?? [],
      times_transcript_hash: (r as any).times_transcript_hash ?? undefined,
    };
  },
});

export const getMessagesForThread = internalQuery({
  args: { thread_id: v.string(), limit: v.number() },
  handler: async (ctx, { thread_id, limit }) => {
    const rows = await ctx.db
      .query("hygglo_messages")
      .withIndex("by_thread", (q) => q.eq("thread_id", thread_id))
      .collect();
    rows.sort((a, b) => (a.hygglo_sent_at ?? a.fetched_at) - (b.hygglo_sent_at ?? b.fetched_at));
    return rows.slice(-limit).map((m) => ({
      sender: m.sender,
      body_text: m.body_text,
      hygglo_sent_at: m.hygglo_sent_at,
    }));
  },
});

export const setTimes = internalMutation({
  args: {
    reservation_id: v.id("reservations"),
    transcript_hash: v.string(),
    patch: v.object({
      pickup_time: v.optional(v.string()),
      return_time: v.optional(v.string()),
      pickup_date: v.optional(v.string()),
      return_date: v.optional(v.string()),
      pickup_method: v.optional(v.string()),
      return_method: v.optional(v.string()),
    }),
  },
  handler: async (ctx, { reservation_id, transcript_hash, patch }) => {
    await ctx.db.patch(reservation_id, {
      ...patch,
      times_transcript_hash: transcript_hash,
      times_extracted_at: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * Reservations needing extraction:
 *   - has hygglo_order_id (a thread to read)
 *   - has start_date + end_date (time validation needs them)
 *   - not is_obsolete
 *   - end_date >= today - 1 (skip ancient completed rentals)
 *   - either times_transcript_hash is unset OR the latest message in the
 *     thread is newer than times_extracted_at (transcript changed)
 *
 * The action's per-row hash check is the precise guard; this query is the
 * cheap pre-filter so the cron doesn't fan out into ~1700 LLM calls.
 */
export const listNeedingExtraction = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const cutoff = new Date(Date.now() - 86400000).toISOString().slice(0, 10); // yesterday
    const all = await ctx.db.query("reservations").collect();

    const candidates = all.filter((r) => {
      if (!r.hygglo_order_id) return false;
      if (r.is_obsolete) return false;
      if (!r.start_date || !r.end_date) return false;
      if ((r.end_date as string) < cutoff) return false;
      return true;
    });
    // Newest first — most relevant for what's about to happen.
    candidates.sort((a, b) => (b._creationTime ?? 0) - (a._creationTime ?? 0));

    const out: typeof candidates[number]["_id"][] = [];
    for (const r of candidates) {
      // Cheap pre-filter: skip if extraction ran recently AND we have at least one time stored.
      const extractedAt = (r as { times_extracted_at?: number }).times_extracted_at;
      const hasAnyTime = !!r.pickup_time || !!r.return_time;
      if (extractedAt && hasAnyTime && Date.now() - extractedAt < 3600 * 1000) continue;
      out.push(r._id);
      if (out.length >= limit) break;
    }
    return out;
  },
});
