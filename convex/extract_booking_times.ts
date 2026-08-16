// DEPRECATED 2026-05-16 — `extractBatch` only.
// The scheduled batch sweep was lifted to Trigger.dev
// (src/trigger/extract-booking-times.ts). `extractForReservation` is
// still live — called from convex/hygglo.ts poll path. Don't delete the
// file; just the unused `extractBatch` export.

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Booking time extractor — pickup/return time + date + method.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Hygglo's API does NOT expose pickup_time / return_time on the order
 * detail (`detail.booking.pickup_time` is always undefined in practice).
 * The actual schedule is negotiated in the owner-renter chat. v1
 * (rental-manager) proved a reliable approach: read the last ~20 chat
 * messages, ask an LLM for the FINAL AGREED times, validate, persist.
 *
 * This action ports v1's `autonomous.service.ts:extractAndUpdateTimes`
 * to v2 using Grok 4.3 + structured-output parsing. Idempotent via
 * `times_transcript_hash` — skips when the conversation hasn't changed.
 *
 * Slots (Daniel's business rules):
 *   morning pickups   10:00-12:00
 *   evening pickups   19:00-21:30
 *   evening returns   19:00-21:30 (same window)
 *   anything outside → flag, do not persist
 */

"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { gatedGenerateObject } from "./lib/gatedGenerate";
import { getActionLlmModel } from "./item_resolver";
import { isWithinUkQuietHours } from "./lib/quiet_hours";
import {
  hashBookingTimeTranscript,
  transcriptHasTimeLanguage,
} from "../src/lib/booking-time-transcript";
import {
  BookingTimeSchema,
  buildBookingTimeMessages,
  dateWithinTolerance,
  sanitizeTime,
  type ExtractedBookingTimes,
} from "../src/lib/booking-time-extraction";

/**
 * Extract pickup/return times for one reservation by reading its message
 * thread. Idempotent via transcript hash. Returns a status object.
 */
export const extractForReservation = action({
  args: { reservation_id: v.id("reservations") },
  handler: async (ctx, { reservation_id }): Promise<{
    ok: boolean;
    skipped?: string;
    confidence?: string;
    extracted?: ExtractedBookingTimes;
  }> => {
    if (isWithinUkQuietHours()) {
      console.log("[quiet-hours] skip extractForReservation", reservation_id);
      return { ok: true, skipped: "uk_quiet_hours" };
    }
    const r = await ctx.runQuery(internal.extract_booking_times_q.getReservationForExtract, { reservation_id });
    if (!r) return { ok: false, skipped: "not found" };
    if (!r.hygglo_order_id) return { ok: false, skipped: "no thread" };
    if (!r.start_date || !r.end_date) return { ok: false, skipped: "no dates" };

    const messages = await ctx.runQuery(internal.extract_booking_times_q.getMessagesForThread, {
      thread_id: r.hygglo_order_id,
      limit: 32,
    });
    if (messages.length === 0) return { ok: false, skipped: "no messages" };

    const hash = hashBookingTimeTranscript(messages);
    if (r.times_transcript_hash === hash) return { ok: true, skipped: "fresh" };

    // Pre-filter: skip if no time-content
    if (!transcriptHasTimeLanguage(messages)) {
      // Still mark hash so we don't re-evaluate the same content.
      await ctx.runMutation(internal.extract_booking_times_q.setTimes, {
        reservation_id, transcript_hash: hash, patch: {},
      });
      return { ok: true, skipped: "no time content" };
    }

    const transcript = messages
      .map((m: { sender: string; body_text: string; hygglo_sent_at?: number }) => {
        const role = m.sender === "owner" ? "Owner" : "Renter";
        const ts = m.hygglo_sent_at ? ` [${new Date(m.hygglo_sent_at).toISOString().replace("T", " ").substring(0, 16)}]` : "";
        return `${role}${ts}: ${m.body_text}`;
      })
      .join("\n");

    const itemTitle = (r.items ?? []).map((i: { item_name: string }) => i.item_name).join(" + ") || "rental";
    const { system, user } = buildBookingTimeMessages(itemTitle.slice(0, 120), r.start_date, r.end_date, transcript);

    let ext: ExtractedBookingTimes;
    try {
      const gated = await gatedGenerateObject({
        // Immediate, message-triggered extraction must use the same Grok 4.3
        // lane as the Trigger recovery batch; otherwise calendar times could
        // differ depending on which path happened to run first.
        model: await getActionLlmModel({ calendarExtraction: true }),
        schema: BookingTimeSchema,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        // Nine short structured fields; Grok Fast reasoning is disabled for
        // this extraction, so keeping this cap tight controls cost.
        maxOutputTokens: 700,
        context: { source: "convex:extract_booking_times", tag: "extract-booking-times" },
      });
      if (gated.skipped) return { ok: true, skipped: "uk_quiet_hours" };
      ext = gated.result.object;
    } catch (err) {
      console.error("[extract_booking_times] LLM call failed:", err);
      return { ok: false, skipped: "llm error" };
    }

    // Cancellation: do not persist new times, but log.
    if (ext.status === "cancelled") {
      console.warn(`[extract_booking_times] CANCELLED detected for ${reservation_id}: ${ext.notes ?? ""}`);
      await ctx.runMutation(internal.extract_booking_times_q.setTimes, {
        reservation_id, transcript_hash: hash, patch: {},
      });
      return { ok: true, skipped: "cancelled", extracted: ext };
    }

    // LOW confidence — still persist but flag in caller.
    // Sanitize times against business slots.
    const sanitizedPickup = sanitizeTime(ext.pickup_time);
    const sanitizedReturn = sanitizeTime(ext.return_time);

    // Validate dates within tolerance.
    const validPickupDate = dateWithinTolerance(ext.pickup_date, r.start_date) ? ext.pickup_date : undefined;
    const validReturnDate = dateWithinTolerance(ext.return_date, r.end_date) ? ext.return_date : undefined;

    const patch: Record<string, string> = {};
    if (sanitizedPickup) patch.pickup_time = sanitizedPickup;
    if (sanitizedReturn) patch.return_time = sanitizedReturn;
    if (validPickupDate) patch.pickup_date = validPickupDate;
    if (validReturnDate) patch.return_date = validReturnDate;
    if (ext.pickup_method && ["delivery", "collection"].includes(ext.pickup_method)) patch.pickup_method = ext.pickup_method;
    if (ext.return_method && ["delivery", "collection"].includes(ext.return_method)) patch.return_method = ext.return_method;

    await ctx.runMutation(internal.extract_booking_times_q.setTimes, {
      reservation_id, transcript_hash: hash, patch,
    });
    return { ok: true, confidence: ext.confidence, extracted: ext };
  },
});

// extractBatch deleted 2026-05-24 — lifted to src/trigger/extract-booking-times.ts
// in Phase 18.5 (LLM-on-Trigger rule from CLAUDE.md). The Convex action was
// orphaned with zero callers after the lift.
