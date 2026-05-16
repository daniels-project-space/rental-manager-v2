/**
 * extract-booking-times — Trigger.dev port of the Convex booking-time
 * extractor action.
 *
 * Reads each candidate reservation's last 20 chat messages, asks Grok
 * for the FINAL AGREED pickup/return times, persists via mutation.
 * Idempotent via transcript hash.
 *
 * Cadence: every 30 min (matches the post-Tier-1 Convex cron cadence).
 *
 * SAFETY: When this task is enabled, REMOVE the matching Convex cron
 * (`booking_time_extractor batch` in convex/crons.ts).
 */
import { schedules, logger } from "@trigger.dev/sdk/v3";
import { generateText } from "ai";
import { createXai } from "@ai-sdk/xai";
import { isWithinUkQuietHours } from "../lib/quiet-hours";

const VAULT_URL = "https://fantastic-roadrunner-485.convex.cloud";
const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://hearty-oyster-600.convex.cloud";

async function getVaultSecret(service: string, keyName: string): Promise<string> {
  const res = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "secrets:listByService",
      args: { service },
      format: "json",
    }),
  });
  if (!res.ok) throw new Error(`vault: ${res.status}`);
  const data = (await res.json()) as {
    value?: Array<{ keyName: string; value: string }>;
  };
  for (const s of data.value ?? []) if (s.keyName === keyName) return s.value;
  throw new Error(`${keyName} missing in vault service=${service}`);
}

let _xai: ReturnType<typeof createXai> | null = null;
async function getXai() {
  if (_xai) return _xai;
  const key = process.env.XAI_API_KEY ?? (await getVaultSecret("xai", "XAI_API_KEY"));
  _xai = createXai({ apiKey: key });
  return _xai;
}

// ── Helpers (ported from convex/extract_booking_times.ts) ──────────────

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
- If the renter changed times during the conversation, use the MOST RECENT agreed time.
- Renters often change their mind, negotiate, or give vague times — only use the FINAL agreed version.
- If the renter said a time and the bot confirmed/acknowledged it, that counts as agreed.
- Pickup and return are SEPARATE events — extract each independently from the conversation.
- If only one time was mentioned for "collection" or "pickup and return", use it for both.
- Convert vague times: "morning" = 10:00, "evening" = 19:00, "noon" = 12:00.
- If AM/PM is missing, infer from context (rental pickups are usually daytime: 8-11 = AM, 12-21 = as-is).
- Times like "7pm" = 19:00, "10am" = 10:00, "6.30" with PM context = 18:30.
- If no times were discussed at all, output NONE for both.
- IMPORTANT: Do NOT confuse arrival ETAs ("I'll be there at 20:32") with the AGREED pickup/return time slot.
- If the renter corrected themselves (e.g., first said 11am then 8pm), use the LAST corrected time.

CRITICAL — DATES:
- The rental period is ${startDate} to ${endDate}, but pickup/return dates may DIFFER.
- Pickup can be the EVENING BEFORE the rental starts.
- Return can be the MORNING AFTER the rental ends.
- Determine the actual date from context.
- If no specific date context, default pickup to ${startDate} and return to ${endDate}. NEVER output NONE for dates.

DELIVERY METHOD DETECTION:
- ONLY mark as DELIVERY if the courier was ACTUALLY BOOKED/CONFIRMED.
- If delivery was discussed but NOT confirmed, output COLLECTION.
- If delivery was never discussed, output UNKNOWN.

Respond ONLY with these nine lines:
PICKUP_TIME: HH:MM or NONE
PICKUP_DATE: YYYY-MM-DD (default to ${startDate} if unknown — NEVER output NONE)
PICKUP_METHOD: DELIVERY or COLLECTION or UNKNOWN
RETURN_TIME: HH:MM or NONE
RETURN_DATE: YYYY-MM-DD (default to ${endDate} if unknown — NEVER output NONE)
RETURN_METHOD: DELIVERY or COLLECTION or UNKNOWN
STATUS: ACTIVE or CANCELLED
CONFIDENCE: HIGH or LOW
NOTES: <any relevant context>`;
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
      args: { limit, messages_per_thread: 20 },
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
  cron: "*/30 * * * *",
  maxDuration: 240,
  run: async (_payload, { ctx }) => {
    if (isWithinUkQuietHours()) {
      logger.info("[quiet-hours] skipped", { task: "extract-booking-times" });
      return { skipped: true, reason: "uk_quiet_hours" };
    }
    const { candidates } = await fetchBatch(10);
    if (candidates.length === 0) {
      logger.info("extract-booking-times: pool empty", { runId: ctx.run.id });
      return { ok: true, processed: 0, idle: true };
    }

    let processed = 0;
    let updated = 0;
    let skipped = 0;
    for (const c of candidates) {
      if (c.messages.length === 0) {
        skipped++;
        continue;
      }
      const newHash = hashTranscript(c.messages);
      if (c.times_transcript_hash === newHash) {
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

      let extracted: ExtractedTimes;
      try {
        const result = await generateText({
          model: (await getXai())("grok-4.3"),
          prompt: buildPrompt(c.title, c.start_date, c.end_date, transcript),
        });
        extracted = parseResponse(result.text);
      } catch (err) {
        logger.error("extract-booking-times: LLM failed", {
          reservation_id: c.id,
          err: String(err),
        });
        continue;
      }

      // Cancelled flow: persist nothing (leave existing data alone).
      if (extracted.status === "CANCELLED") {
        skipped++;
        continue;
      }

      const patch: ExtractedTimes = {
        pickup_time: sanitizeTime(extracted.pickup_time),
        return_time: sanitizeTime(extracted.return_time),
        pickup_method: extracted.pickup_method,
        return_method: extracted.return_method,
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

    logger.info("extract-booking-times: done", {
      runId: ctx.run.id,
      processed,
      updated,
      skipped,
      candidates: candidates.length,
    });
    return { ok: true, processed, updated, skipped };
  },
});
