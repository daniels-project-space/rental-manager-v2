import { z } from "zod";

/** Normalise common model formats without silently turning 7 PM into 07:00. */
export function sanitizeTime(value: string | undefined | null): string | undefined {
  if (!value || /^none$/i.test(value.trim())) return undefined;
  const match = /^(\d{1,2})(?:(?:[:.])(\d{2}))?\s*([ap])\.?m\.?$/i.exec(value.trim())
    ?? /^(\d{1,2})(?:(?:[:.])(\d{2}))$/.exec(value.trim());
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    if (meridiem === "p" && hour !== 12) hour += 12;
    if (meridiem === "a" && hour === 12) hour = 0;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function dateWithinTolerance(
  target: string | undefined | null,
  ref: string | undefined,
  tolDays = 3,
): boolean {
  if (!target || !ref) return false;
  const targetMs = Date.parse(`${target}T00:00:00Z`);
  const refMs = Date.parse(`${ref}T00:00:00Z`);
  if (Number.isNaN(targetMs) || Number.isNaN(refMs)) return false;
  return Math.abs(targetMs - refMs) / 86_400_000 <= tolDays;
}

/**
 * Structured-output contract for booking-time extraction (2026-08-16).
 *
 * Previously the model returned 9 free-text lines parsed with per-line regex
 * (`lineValue`) — any line the model phrased slightly off (extra words, wrong
 * label casing, a missing colon) just silently failed to match and that field
 * quietly vanished, with no error and no retry. That is a plausible root
 * cause of "wrong day/wrong time" complaints: not the model being wrong, but
 * a correct answer getting dropped on the way out.
 *
 * A Zod schema makes the shape a contract the model cannot violate: `ai`'s
 * `generateObject` (via `gatedGenerateObject`) validates the response against
 * this schema and THROWS if it doesn't fit — which both callers already
 * catch as `llmErrors++`, an existing path that alerts Daniel via Telegram
 * after 3 failures. So a malformed response is now a loud, already-alerted
 * failure instead of a silent partial one.
 *
 * `pickup_time`/`return_time` are regex-anchored to 24h HH:MM — the model
 * cannot emit "7pm" or "19.00"; it must convert, exactly as the instructions
 * already asked it to (this was previously an unenforced request). Dates are
 * non-nullable strings, so "never output NONE for dates" — previously just an
 * instruction the model could ignore — is now structurally impossible to
 * violate. `sanitizeTime`/`dateWithinTolerance` remain as a defensive
 * post-parse check even though the schema already constrains shape.
 */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const BookingTimeSchema = z.object({
  pickup_time: z.string().regex(HHMM).nullable()
    .describe("24-hour HH:MM of the LAST agreed pickup time, or null if handoff time was never discussed"),
  return_time: z.string().regex(HHMM).nullable()
    .describe("24-hour HH:MM of the LAST agreed return time, or null if handoff time was never discussed"),
  pickup_date: z.string().regex(YMD)
    .describe("YYYY-MM-DD. Default to start_date if no specific date context exists — never omit"),
  return_date: z.string().regex(YMD)
    .describe("YYYY-MM-DD. Default to end_date if no specific date context exists — never omit"),
  pickup_method: z.enum(["delivery", "collection", "unknown"])
    .describe("delivery only if a courier was actually booked/confirmed, not merely discussed"),
  return_method: z.enum(["delivery", "collection", "unknown"]),
  status: z.enum(["active", "cancelled"])
    .describe("cancelled only if the latest messages cancel the rental; a time change alone stays active"),
  confidence: z.enum(["high", "low"])
    .describe("low if AM/PM or the day was ambiguous and had to be inferred"),
  notes: z.string()
    .describe("Relevant corrections, cancellation signals, or ambiguity. Empty string if none."),
});

export type ExtractedBookingTimes = z.infer<typeof BookingTimeSchema>;

// Invariant system prompt shared by the immediate Convex lane and the Trigger
// recovery lane. Kept as its own message (not concatenated with per-call
// variable context) so it stays a stable, cacheable prefix across every call.
export const BOOKING_TIME_INSTRUCTIONS = `You are extracting the FINAL AGREED pickup and return schedule from a rental equipment chat.

INSTRUCTIONS:
- Find the LAST pickup and return times agreed or confirmed by both parties; later corrections replace earlier proposals.
- A renter's time counts as agreed when the owner/bot confirms or acknowledges it.
- Pickup and return are separate. If one agreed time explicitly covers both, use it for both.
- Convert natural time language: morning = 10:00, evening = 19:00, noon = 12:00. Preserve exact stated minutes.
- Convert 7pm to 19:00, 10am to 10:00 and 6.30pm to 18:30.
- If AM/PM is absent, infer only from clear rental context. If ambiguous, say so in notes and use LOW confidence.
- Ignore arrival ETAs and journey updates such as "I'll be there at 20:32" or "10 mins away" unless they explicitly renegotiate the rental handoff time.
- If no handoff times were discussed, use null for both times.

DATES:
- Pickup may be the evening before the nominal start date; return may be the morning after the nominal end date.
- Use message timestamps to resolve today, tonight, tomorrow and named days.
- If no specific date context exists, default pickup to start_date and return to end_date.

METHODS:
- delivery means a courier was actually booked/confirmed, not merely discussed or quoted.
- If delivery was discussed but not confirmed, use collection. If never discussed, use unknown.

STATUS:
- If the latest messages cancel the rental, use cancelled. A time change without cancellation stays active.`;

/**
 * Per-call messages: static instructions as `system` (cacheable across every
 * call), rental-specific context as `user`. Splitting these into separate
 * messages is a stronger cache-safety guarantee than the old single
 * concatenated string, since the system message never changes byte-for-byte.
 */
export function buildBookingTimeMessages(
  rentalTitle: string,
  startDate: string,
  endDate: string,
  transcript: string,
  now: Date = new Date(),
): { system: string; user: string } {
  const nowText = now.toISOString().replace("T", " ").substring(0, 16);
  return {
    system: BOOKING_TIME_INSTRUCTIONS,
    user: `Current date/time: ${nowText} UTC
Equipment: ${rentalTitle}
start_date: ${startDate}
end_date: ${endDate}

=== CONVERSATION ===
${transcript}
=== END ===`,
  };
}
