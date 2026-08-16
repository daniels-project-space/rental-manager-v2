/**
 * extract-booking-times — Trigger.dev port of the Convex booking-time
 * extractor action.
 *
 * Reads each candidate reservation's last 20 chat messages, asks Grok 4.3
 * for the FINAL AGREED pickup/return times, persists via mutation.
 * Idempotent via transcript hash.
 *
 * Cadence: every 30 min (matches the post-Tier-1 Convex cron cadence).
 *
 * SAFETY: When this task is enabled, REMOVE the matching Convex cron
 * (`booking_time_extractor batch` in convex/crons.ts).
 */
import { schedules, logger } from "@trigger.dev/sdk/v3";
import { gatedGenerateObject } from "../lib/gated-generate";
import { isWithinUkQuietHours } from "../lib/quiet-hours";
import { getExtractorModel } from "../lib/llm-client";
import { sendOperatorMessage } from "../lib/telegram";
import {
  hashBookingTimeTranscript,
  transcriptHasTimeLanguage,
} from "../lib/booking-time-transcript";
import {
  BookingTimeSchema,
  buildBookingTimeMessages,
  dateWithinTolerance,
  sanitizeTime,
  type ExtractedBookingTimes,
} from "../lib/booking-time-extraction";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";

// ── Convex HTTP plumbing ───────────────────────────────────────────────

interface Message {
  sender: string;
  body_text: string;
  hygglo_sent_at: number | undefined;
}
interface Candidate {
  id: string;
  hygglo_order_id: string;
  title: string;
  start_date: string;
  end_date: string;
  messages: Message[];
  times_transcript_hash: string | null;
}

async function fetchBatch(limit: number): Promise<{ candidates: Candidate[] }> {
  const res = await fetch(`${CONVEX_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "extract_booking_times_q:admin_getExtractBatchInputs",
      args: { limit, messages_per_thread: 32 },
      format: "json",
    }),
  });
  const data = (await res.json()) as {
    status: string;
    value?: { candidates: Candidate[] };
    errorMessage?: string;
  };
  if (data.status !== "success") throw new Error(`extract batch fetch: ${data.errorMessage}`);
  return data.value!;
}

async function writeTimes(args: {
  reservation_id: string;
  transcript_hash: string;
  patch: {
    pickup_time?: string;
    return_time?: string;
    pickup_date?: string;
    return_date?: string;
    pickup_method?: string;
    return_method?: string;
  };
}): Promise<void> {
  const res = await fetch(`${CONVEX_URL}/api/mutation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "extract_booking_times_q:admin_setExtractedTimes",
      args,
      format: "json",
    }),
  });
  const data = (await res.json()) as { status: string; errorMessage?: string };
  if (data.status !== "success") throw new Error(`extract write: ${data.errorMessage}`);
}

// ── Scheduled task ────────────────────────────────────────────────────

export const extractBookingTimesTask = schedules.task({
  id: "extract-booking-times",
  // New messages trigger extraction immediately; this is only a recovery
  // sweep for quiet-hours skips or failed targeted runs.
  cron: "0 */6 * * *", // every 6 hours; new messages extract immediately
  maxDuration: 240,
  run: async (_payload, { ctx }) => {
    if (isWithinUkQuietHours()) {
      logger.info("[quiet-hours] skipped", { task: "extract-booking-times" });
      return { skipped: true, reason: "uk_quiet_hours" };
    }
    // 40 (was 10): candidate selection is now change-driven server-side
    // (extract_booking_times_q:admin_getExtractBatchInputs only returns
    // reservations whose transcript changed since the last extraction), so a
    // higher cap processes ALL of them in one run without starving older
    // bookings — while the per-row transcript-hash guard below still prevents
    // any wasted LLM call. The query already sorts soonest-handover-first.
    const { candidates } = await fetchBatch(40);
    if (candidates.length === 0) {
      // Queue-idle gate: no reservations need booking-time extraction.
      logger.info("queue idle, skipping run", { task: "extract-booking-times" });
      return { skipped: true };
    }

    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let llmErrors = 0;
    let firstLlmError: string | null = null;
    for (const c of candidates) {
      if (c.messages.length === 0) {
        skipped++;
        continue;
      }
      const newHash = hashBookingTimeTranscript(c.messages);
      if (c.times_transcript_hash === newHash) {
        // Conversation.last_msg_at may advance from send bookkeeping even if
        // the bounded transcript is identical. Acknowledge the check once so
        // this row does not churn in every hourly batch forever.
        await writeTimes({ reservation_id: c.id, transcript_hash: newHash, patch: {} });
        skipped++;
        continue;
      }
      if (!transcriptHasTimeLanguage(c.messages)) {
        await writeTimes({ reservation_id: c.id, transcript_hash: newHash, patch: {} });
        skipped++;
        continue;
      }
      const transcript = c.messages
        .map((m) => {
          const ts = m.hygglo_sent_at
            ? new Date(m.hygglo_sent_at).toISOString().substring(0, 16).replace("T", " ")
            : "??";
          return `[${ts}] ${m.sender}: ${m.body_text}`;
        })
        .join("\n");

      let extracted: ExtractedBookingTimes;
      try {
        const { system, user } = buildBookingTimeMessages(c.title, c.start_date, c.end_date, transcript);
        const gated = await gatedGenerateObject({
          model: await getExtractorModel(),
          schema: BookingTimeSchema,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          // Nine short fields (~150 visible tokens). Grok 4.3 is called with
          // reasoning disabled, so 700 is generous — and a low cap matters:
          // OpenRouter rejects calls whose max_tokens exceed
          // the affordable balance ("requires more credits, or fewer
          // max_tokens"), which is exactly how extraction silently died for 2
          // days when credits ran low (2026-07-13 Anker incident).
          maxOutputTokens: 700,
          context: { source: "trigger:extract-booking-times", tag: "extract-booking-times" },
        });
        if (gated.skipped) {
          logger.info("[quiet-hours] gated skip", { task: "extract-booking-times", reservation_id: c.id });
          skipped++;
          continue;
        }
        extracted = gated.result.object;
      } catch (err) {
        llmErrors++;
        if (!firstLlmError) firstLlmError = String(err);
        logger.error("extract-booking-times: LLM failed", {
          reservation_id: c.id,
          err: String(err),
        });
        continue;
      }

      // Cancelled flow: persist nothing (leave existing data alone).
      if (extracted.status === "cancelled") {
        await writeTimes({ reservation_id: c.id, transcript_hash: newHash, patch: {} });
        skipped++;
        continue;
      }

      const patch: Parameters<typeof writeTimes>[0]["patch"] = {
        pickup_time: sanitizeTime(extracted.pickup_time),
        return_time: sanitizeTime(extracted.return_time),
        pickup_method: ["delivery", "collection"].includes(extracted.pickup_method)
          ? extracted.pickup_method
          : undefined,
        return_method: ["delivery", "collection"].includes(extracted.return_method)
          ? extracted.return_method
          : undefined,
      };
      // Only persist dates that are within tolerance of the rental window.
      if (dateWithinTolerance(extracted.pickup_date, c.start_date, 3)) {
        patch.pickup_date = extracted.pickup_date;
      }
      if (dateWithinTolerance(extracted.return_date, c.end_date, 3)) {
        patch.return_date = extracted.return_date;
      }
      // Drop empty keys so the mutation patch stays minimal.
      const cleanPatch = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined),
      ) as typeof patch;

      try {
        await writeTimes({
          reservation_id: c.id,
          transcript_hash: newHash,
          patch: cleanPatch,
        });
        updated++;
      } catch (err) {
        logger.warn("extract-booking-times: mutation write failed", {
          reservation_id: c.id,
          err: String(err),
        });
      }
      processed++;
    }

    // Systemic-failure alarm (2026-07-13): when EVERY attempted extraction
    // dies at the LLM step (e.g. OpenRouter out of credits, provider pin
    // rejecting), booking times silently stop flowing to the calendar — the
    // Anker return-Monday incident went unnoticed for 2 days. Tell Daniel
    // directly instead of only logging.
    if (llmErrors >= 3 && updated === 0) {
      try {
        await sendOperatorMessage(
          `⚠️ Booking-time extraction failing: ${llmErrors} LLM errors, 0 extracted this run.\n` +
            `Calendar times will go stale until fixed.\nFirst error: ${String(firstLlmError).slice(0, 300)}`,
        );
      } catch (alertErr) {
        logger.warn("extract-booking-times: telegram alert failed", { err: String(alertErr) });
      }
    }

    logger.info("extract-booking-times: done", {
      runId: ctx.run.id,
      processed,
      updated,
      skipped,
      llmErrors,
      candidates: candidates.length,
    });
    return { ok: true, processed, updated, skipped, llmErrors };
  },
});
