/**
 * Internal queries/mutations for the booking-time extractor action.
 * Action runs in Node; these run in the Convex runtime.
 */

import { v } from "convex/values";
import { internalQuery, internalMutation, query, mutation } from "./_generated/server";

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
      // Skip if extraction ran in the last hour — the action's transcript-hash
      // guard inside the action handles the precise dedup. Some chats have no
      // time content yet (renter hasn't picked a slot), so the absence of
      // pickup_time isn't a reason to re-run.
      const extractedAt = (r as { times_extracted_at?: number }).times_extracted_at;
      if (extractedAt && Date.now() - extractedAt < 3600 * 1000) continue;
      out.push(r._id);
      if (out.length >= limit) break;
    }
    return out;
  },
});

// ───────────────────────────────────────────────────────────────────────
// Booking-time-extractor Trigger.dev orchestration surface.
// Lifted to src/trigger/extract-booking-times.ts. Returns each
// candidate reservation pre-joined with its chat thread so the Trigger
// task makes ONE HTTP query per batch instead of N+1.
// ───────────────────────────────────────────────────────────────────────

export const admin_getExtractBatchInputs = query({
  args: { limit: v.number(), messages_per_thread: v.optional(v.number()) },
  handler: async (ctx, { limit, messages_per_thread }) => {
    const msgLimit = messages_per_thread ?? 20;
    const cutoffStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const all = await ctx.db.query("reservations").collect();

    type Row = (typeof all)[number] & {
      hygglo_order_id?: string;
      start_date?: string;
      end_date?: string;
      items?: Array<{ item_name: string }>;
      times_transcript_hash?: string;
      times_extracted_at?: number;
    };

    const candidates: Row[] = [];
    for (const r of all as Row[]) {
      if (!r.hygglo_order_id) continue;
      if (r.is_obsolete) continue;
      if (!r.start_date || !r.end_date) continue;
      if ((r.end_date as string) < cutoffStr) continue;
      const extractedAt = r.times_extracted_at;
      if (extractedAt && Date.now() - extractedAt < 3600 * 1000) continue;
      candidates.push(r);
    }
    candidates.sort((a, b) => (b._creationTime ?? 0) - (a._creationTime ?? 0));

    const picks = candidates.slice(0, limit);

    // Pull each candidate's last N messages — cheaper than N separate HTTP
    // calls; we do it server-side in one trip via indexed reads.
    type Message = { sender: string; body_text: string; hygglo_sent_at: number | undefined };
    const out = [] as Array<{
      id: string;
      hygglo_order_id: string;
      title: string;
      start_date: string;
      end_date: string;
      messages: Message[];
      times_transcript_hash: string | null;
    }>;
    for (const r of picks) {
      const msgs = await ctx.db
        .query("hygglo_messages")
        .withIndex("by_thread", (q) => q.eq("thread_id", r.hygglo_order_id as string))
        .collect();
      msgs.sort((a, b) => (a.hygglo_sent_at ?? a.fetched_at) - (b.hygglo_sent_at ?? b.fetched_at));
      const tail = msgs.slice(-msgLimit).map((m) => ({
        sender: m.sender,
        body_text: m.body_text,
        hygglo_sent_at: m.hygglo_sent_at,
      }));
      out.push({
        id: r._id as string,
        hygglo_order_id: r.hygglo_order_id as string,
        title: (r.items ?? []).map((i) => i.item_name).join(" + "),
        start_date: r.start_date as string,
        end_date: r.end_date as string,
        messages: tail,
        times_transcript_hash: r.times_transcript_hash ?? null,
      });
    }
    return { candidates: out };
  },
});

export const admin_setExtractedTimes = mutation({
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
