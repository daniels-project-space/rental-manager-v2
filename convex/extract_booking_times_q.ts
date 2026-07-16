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
      .order("desc")
      .take(limit);
    rows.reverse();
    return rows.map((m) => ({
      sender: m.sender,
      body_text: m.body_text,
      hygglo_sent_at: m.hygglo_sent_at ?? m.fetched_at,
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
    // 2026-07-12 cost audit: bounded scan. Candidates require end_date >=
    // yesterday, and no real Hygglo rental spans 400 days, so rows starting
    // earlier can never qualify (same reasoning as items.getOutOfStockItems'
    // lower bound). Rows with undefined start_date are excluded by the index
    // range AND were already dropped by the !r.start_date filter below.
    const scanStart = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
    const all = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", scanStart))
      .collect();

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
//
// CHANGE-DRIVEN SELECTION (2026-07-11) — fixes both a correctness bug and a
// bandwidth drain. The old body `.collect()`-ed the ENTIRE reservations table
// (~2.9k rows / ~5 MB) every run, then kept only the newest 10 BY CREATION
// DATE. That (a) read a huge amount of data and (b) STARVED any reservation
// whose transcript changed but whose creation date wasn't in the top 10 — a
// freshly-confirmed return time on an older booking was never re-extracted
// (observed: 35 candidates, 15 with changed transcripts, 9 starved beyond
// rank 10; Criz rank 23 + Olivia rank 27, both with an agreed return time that
// never reached the calendar).
//
// Now we drive off conversations.last_msg_at — stamped by hygglo.upsertMessages
// on every new message and indexed (by_last_msg_at). We read ONLY threads
// active within ACTIVE_WINDOW_DAYS (an indexed range read, not a table scan),
// join to the reservation, and keep only those whose last message is NEWER than
// the last extraction attempt (times_extracted_at). That is exactly the "needs
// re-extraction" set — far fewer rows read, and no reservation can be starved.
// Soonest-handover-first so imminent returns always win the per-run cap.
// ───────────────────────────────────────────────────────────────────────

const ACTIVE_WINDOW_DAYS = 21;

export const admin_getExtractBatchInputs = query({
  args: { limit: v.number(), messages_per_thread: v.optional(v.number()) },
  handler: async (ctx, { limit, messages_per_thread }) => {
    const msgLimit = messages_per_thread ?? 20;
    const cutoffStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const sinceMs = Date.now() - ACTIVE_WINDOW_DAYS * 86400000;

    // Only threads with recent chat activity — indexed range read, not a scan.
    const convs = await ctx.db
      .query("conversations")
      .withIndex("by_last_msg_at", (q) => q.gt("last_msg_at", sinceMs))
      .collect();

    type Message = { sender: string; body_text: string; hygglo_sent_at: number | undefined };
    type Candidate = {
      id: string;
      hygglo_order_id: string;
      title: string;
      start_date: string;
      end_date: string;
      messages: Message[];
      times_transcript_hash: string | null;
    };

    // Join each active thread to its reservation, keep only the ones with a
    // message newer than the last extraction attempt.
    const picked: Array<Candidate & { _end: string; _lastMsgAt: number }> = [];
    for (const conv of convs) {
      const r = await ctx.db
        .query("reservations")
        .withIndex("by_hygglo_order_id", (q) => q.eq("hygglo_order_id", conv.thread_id))
        .first();
      if (!r) continue;
      if (r.is_obsolete) continue;
      if (!r.hygglo_order_id) continue;
      if (!r.start_date || !r.end_date) continue;
      if ((r.end_date as string) < cutoffStr) continue;
      // Re-extract only when a message arrived AFTER the last extraction attempt.
      const extractedAt = (r as { times_extracted_at?: number }).times_extracted_at ?? 0;
      if (conv.last_msg_at <= extractedAt) continue;
      picked.push({
        id: r._id as string,
        hygglo_order_id: r.hygglo_order_id as string,
        title: (r.items ?? []).map((i) => i.item_name).join(" + "),
        start_date: r.start_date as string,
        end_date: r.end_date as string,
        messages: [],
        times_transcript_hash: (r as { times_transcript_hash?: string }).times_transcript_hash ?? null,
        _end: r.end_date as string,
        _lastMsgAt: conv.last_msg_at,
      });
    }

    // Soonest handover first; tie-break by most-recently-active.
    picked.sort((a, b) =>
      a._end !== b._end ? (a._end < b._end ? -1 : 1) : b._lastMsgAt - a._lastMsgAt,
    );
    const slice = picked.slice(0, limit);

    // Attach each pick's last N messages (indexed by_thread read — only for the
    // capped slice, so message reads scale with `limit`, not the table).
    for (const c of slice) {
      const msgs = await ctx.db
        .query("hygglo_messages")
        .withIndex("by_thread", (q) => q.eq("thread_id", c.hygglo_order_id))
        .order("desc")
        .take(msgLimit);
      msgs.reverse();
      c.messages = msgs.map((m) => ({
        sender: m.sender,
        body_text: m.body_text,
        hygglo_sent_at: m.hygglo_sent_at ?? m.fetched_at,
      }));
    }

    const candidates: Candidate[] = slice.map((c) => ({
      id: c.id,
      hygglo_order_id: c.hygglo_order_id,
      title: c.title,
      start_date: c.start_date,
      end_date: c.end_date,
      messages: c.messages,
      times_transcript_hash: c.times_transcript_hash,
    }));
    return { candidates };
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
