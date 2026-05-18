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
import { gatedGenerateText } from "./lib/gatedGenerate";
import { getActionLlmModel } from "./item_resolver";
import { isWithinUkQuietHours } from "./lib/quiet_hours";

/**
 * Accept any valid HH:MM. v1's hard-slot rejection was paired with an
 * auto-reply pushing back on the renter; v2 is read-only so we trust the
 * LLM's "FINAL AGREED" judgment. (Daniel still has his preferred slots —
 * 10am-12pm pickup, 7-9:30pm return — but renters often negotiate outside
 * them and the dashboard should reflect reality, not Daniel's wishlist.)
 */
function sanitizeTime(t: string | undefined): string | undefined {
  if (!t) return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return undefined;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

function dateWithinTolerance(target: string | undefined, ref: string | undefined, tolDays = 3): boolean {
  if (!target || !ref) return false;
  const t = Date.parse(target);
  const r = Date.parse(ref);
  if (Number.isNaN(t) || Number.isNaN(r)) return false;
  return Math.abs(t - r) / 86400000 <= tolDays;
}

function hashTranscript(messages: Array<{ body_text: string }>): string {
  const last = messages.map((m) => m.body_text).join("|");
  return `${messages.length}:${last.slice(-200)}`;
}

function buildPrompt(rentalTitle: string, startDate: string, endDate: string, transcript: string): string {
  const now = new Date().toISOString().replace("T", " ").substring(0, 16);
  return `You are extracting the FINAL AGREED pickup and return times from a rental equipment chat.
Current date/time: ${now} UTC

Equipment: ${rentalTitle}
Rental period: ${startDate} to ${endDate}

=== CONVERSATION ===
${transcript}
=== END ===

INSTRUCTIONS:
- Find the LAST pickup and return times that were AGREED or CONFIRMED by both parties.
- If the renter changed times during the conversation, use the MOST RECENT agreed time, not the first one.
- Renters often change their mind, negotiate, or give vague times — only use the FINAL agreed version.
- If the renter said a time and the bot confirmed/acknowledged it, that counts as agreed.
- Pickup and return are SEPARATE events — extract each independently from the conversation.
- If only one time was mentioned for "collection" or "pickup and return", use it for both.
- Convert vague times: "morning" = 10:00, "evening" = 19:00, "noon" = 12:00. There is no afternoon slot — if renter said "afternoon", flag in NOTES.
- If AM/PM is missing, infer from context (rental pickups are usually daytime: 8-11 = AM, 12-21 = as-is).
- Times like "7pm" = 19:00, "10am" = 10:00, "6.30" with PM context = 18:30.
- If no times were discussed at all, output NONE for both.
- IMPORTANT: Do NOT confuse arrival ETAs ("I'll be there at 20:32", "on my way, 10 mins") with the AGREED pickup/return time slot. ETAs are ad-hoc and should be IGNORED.
- If the renter corrected themselves (e.g., first said 11am then 8pm), use the LAST corrected time.
- Morning pickup slots are 10am-12pm, evening slots are 7pm-9:30pm. Flag if outside these windows.

CRITICAL — DATES:
- The rental period is ${startDate} to ${endDate}, but pickup/return dates may DIFFER.
- Pickup can be the EVENING BEFORE the rental starts.
- Return can be the MORNING AFTER the rental ends.
- Determine the actual date for pickup and return from context (day mentioned, "tomorrow", "next day", etc).
- Messages include timestamps [YYYY-MM-DD HH:MM] — use these to resolve "today", "tonight", "tomorrow".
- If no specific date context, default pickup to ${startDate} and return to ${endDate}. NEVER output NONE for dates.

DELIVERY METHOD DETECTION:
- Determine if pickup and/or return is via Addison Lee courier DELIVERY or in-person COLLECTION.
- ONLY mark as DELIVERY if the courier was ACTUALLY BOOKED/CONFIRMED in the conversation.
- Merely discussing delivery, asking about it, getting a quote, or mentioning it does NOT count as confirmed.
- If delivery was discussed but NOT confirmed/agreed, output COLLECTION (the default).
- If delivery was never discussed, output UNKNOWN.

CANCELLATION/CHANGE DETECTION:
- If the renter's LATEST message(s) indicate they want to CANCEL or reschedule, set STATUS to CANCELLED.
- If the renter just changed times (not cancelled), that's still ACTIVE — extract the new times.
- If conversation is proceeding normally, set STATUS to ACTIVE.

Respond ONLY with these nine lines:
PICKUP_TIME: HH:MM or NONE
PICKUP_DATE: YYYY-MM-DD (default to ${startDate} if unknown — NEVER output NONE)
PICKUP_METHOD: DELIVERY or COLLECTION or UNKNOWN
RETURN_TIME: HH:MM or NONE
RETURN_DATE: YYYY-MM-DD (default to ${endDate} if unknown — NEVER output NONE)
RETURN_METHOD: DELIVERY or COLLECTION or UNKNOWN
STATUS: ACTIVE or CANCELLED
CONFIDENCE: HIGH or LOW
NOTES: <any relevant context about time changes, cancellation signals, or ambiguity>`;
}

interface ExtractedTimes {
  pickup_time?: string;
  return_time?: string;
  pickup_date?: string;
  return_date?: string;
  pickup_method?: string;
  return_method?: string;
  status?: "ACTIVE" | "CANCELLED";
  confidence?: "HIGH" | "LOW";
  notes?: string;
}

function parseResponse(raw: string): ExtractedTimes {
  const pick = (re: RegExp): string | undefined => {
    const m = re.exec(raw);
    return m ? m[1].trim() : undefined;
  };
  return {
    pickup_time: pick(/PICKUP_TIME:\s*(\d{1,2}:\d{2})/),
    return_time: pick(/RETURN_TIME:\s*(\d{1,2}:\d{2})/),
    pickup_date: pick(/PICKUP_DATE:\s*(\d{4}-\d{2}-\d{2})/),
    return_date: pick(/RETURN_DATE:\s*(\d{4}-\d{2}-\d{2})/),
    pickup_method: pick(/PICKUP_METHOD:\s*(DELIVERY|COLLECTION|UNKNOWN)/i)?.toLowerCase(),
    return_method: pick(/RETURN_METHOD:\s*(DELIVERY|COLLECTION|UNKNOWN)/i)?.toLowerCase(),
    status: pick(/STATUS:\s*(ACTIVE|CANCELLED)/i)?.toUpperCase() as "ACTIVE" | "CANCELLED" | undefined,
    confidence: pick(/CONFIDENCE:\s*(HIGH|LOW)/i)?.toUpperCase() as "HIGH" | "LOW" | undefined,
    notes: pick(/NOTES:\s*(.+)/i),
  };
}

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
    extracted?: ExtractedTimes;
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
      limit: 20,
    });
    if (messages.length === 0) return { ok: false, skipped: "no messages" };

    const hash = hashTranscript(messages);
    if (r.times_transcript_hash === hash) return { ok: true, skipped: "fresh" };

    // Pre-filter: skip if no time-content
    const joined = messages.map((m: { body_text: string }) => m.body_text).join("\n");
    if (!/\d{1,2}\s*(am|pm|:\d{2})|\bmorning\b|\bevening\b|\bafternoon\b|\bnoon\b/i.test(joined)) {
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
    const prompt = buildPrompt(itemTitle.slice(0, 120), r.start_date, r.end_date, transcript);

    let response: { text: string };
    try {
      const gated = await gatedGenerateText({
        model: await getActionLlmModel(),
        prompt,
        maxOutputTokens: 300,
        context: { source: "convex:extract_booking_times", tag: "extract-booking-times" },
      });
      if (gated.skipped) return { ok: true, skipped: "uk_quiet_hours" };
      response = gated.result;
    } catch (err) {
      console.error("[extract_booking_times] LLM call failed:", err);
      return { ok: false, skipped: "llm error" };
    }

    const ext = parseResponse(response.text);

    // Cancellation: do not persist new times, but log.
    if (ext.status === "CANCELLED") {
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

/** Cron-friendly batch: find reservations needing extraction. */
export const extractBatch = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (
    ctx,
    { limit },
  ): Promise<{ ids: number; ok: number; skipped: number }> => {
    if (isWithinUkQuietHours()) {
      console.log("[quiet-hours] skip extractBatch");
      return { ids: 0, ok: 0, skipped: 0 };
    }
    const ids: Array<string> = await ctx.runQuery(
      internal.extract_booking_times_q.listNeedingExtraction,
      { limit: limit ?? 10 },
    );
    let ok = 0;
    let skipped = 0;
    for (const id of ids) {
      try {
        const res = (await ctx.runAction(
          api.extract_booking_times.extractForReservation,
          { reservation_id: id as never },
        )) as { ok: boolean; skipped?: unknown };
        if (res.ok && !res.skipped) ok++;
        else skipped++;
      } catch (err) {
        console.error("[extract-batch] failed for", id, err);
        skipped++;
      }
    }
    return { ids: ids.length, ok, skipped };
  },
});
