export interface ExtractedBookingTimes {
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

/** Normalise common model formats without silently turning 7 PM into 07:00. */
export function sanitizeTime(value: string | undefined): string | undefined {
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
  target: string | undefined,
  ref: string | undefined,
  tolDays = 3,
): boolean {
  if (!target || !ref) return false;
  const targetMs = Date.parse(`${target}T00:00:00Z`);
  const refMs = Date.parse(`${ref}T00:00:00Z`);
  if (Number.isNaN(targetMs) || Number.isNaN(refMs)) return false;
  return Math.abs(targetMs - refMs) / 86_400_000 <= tolDays;
}

// Invariant prefix shared by the immediate Convex lane and Trigger recovery
// lane. Keeping variable context last improves provider prompt-cache reuse.
export const BOOKING_TIME_INSTRUCTIONS = `You are extracting the FINAL AGREED pickup and return schedule from a rental equipment chat.

INSTRUCTIONS:
- Find the LAST pickup and return times agreed or confirmed by both parties; later corrections replace earlier proposals.
- A renter's time counts as agreed when the owner/bot confirms or acknowledges it.
- Pickup and return are separate. If one agreed time explicitly covers both, use it for both.
- Convert natural time language: morning = 10:00, evening = 19:00, noon = 12:00. Preserve exact stated minutes.
- Convert 7pm to 19:00, 10am to 10:00 and 6.30pm to 18:30.
- If AM/PM is absent, infer only from clear rental context. Mark ambiguous in NOTES and use LOW confidence.
- Ignore arrival ETAs and journey updates such as "I'll be there at 20:32" or "10 mins away" unless they explicitly renegotiate the rental handoff time.
- If no handoff times were discussed, output NONE for both.

DATES:
- Pickup may be the evening before the nominal start date; return may be the morning after the nominal end date.
- Use message timestamps to resolve today, tonight, tomorrow and named days.
- If no specific date context exists, default pickup to start_date and return to end_date. Never output NONE for dates.

METHODS:
- DELIVERY means a courier was actually booked/confirmed, not merely discussed or quoted.
- If delivery was discussed but not confirmed, output COLLECTION. If never discussed, output UNKNOWN.

STATUS:
- If the latest messages cancel the rental, output CANCELLED. A time change without cancellation remains ACTIVE.

Respond ONLY with these nine lines:
PICKUP_TIME: HH:MM or NONE
PICKUP_DATE: YYYY-MM-DD
PICKUP_METHOD: DELIVERY or COLLECTION or UNKNOWN
RETURN_TIME: HH:MM or NONE
RETURN_DATE: YYYY-MM-DD
RETURN_METHOD: DELIVERY or COLLECTION or UNKNOWN
STATUS: ACTIVE or CANCELLED
CONFIDENCE: HIGH or LOW
NOTES: <relevant corrections, cancellation signals, or ambiguity>`;

export function buildBookingTimePrompt(
  rentalTitle: string,
  startDate: string,
  endDate: string,
  transcript: string,
  now: Date = new Date(),
): string {
  const nowText = now.toISOString().replace("T", " ").substring(0, 16);
  return `${BOOKING_TIME_INSTRUCTIONS}

Current date/time: ${nowText} UTC
Equipment: ${rentalTitle}
start_date: ${startDate}
end_date: ${endDate}

=== CONVERSATION ===
${transcript}
=== END ===`;
}

function lineValue(raw: string, label: string): string | undefined {
  const match = new RegExp(`^${label}:\\s*([^\\r\\n]*)`, "im").exec(raw);
  const value = match?.[1]?.trim();
  return value || undefined;
}

export function parseBookingTimeResponse(raw: string): ExtractedBookingTimes {
  const pickupRaw = lineValue(raw, "PICKUP_TIME");
  const returnRaw = lineValue(raw, "RETURN_TIME");
  const pickupDate = lineValue(raw, "PICKUP_DATE");
  const returnDate = lineValue(raw, "RETURN_DATE");
  const pickupMethod = lineValue(raw, "PICKUP_METHOD")?.toUpperCase();
  const returnMethod = lineValue(raw, "RETURN_METHOD")?.toUpperCase();
  const status = lineValue(raw, "STATUS")?.toUpperCase();
  const confidence = lineValue(raw, "CONFIDENCE")?.toUpperCase();
  return {
    pickup_time: sanitizeTime(pickupRaw),
    return_time: sanitizeTime(returnRaw),
    pickup_date: /^\d{4}-\d{2}-\d{2}$/.test(pickupDate ?? "") ? pickupDate : undefined,
    return_date: /^\d{4}-\d{2}-\d{2}$/.test(returnDate ?? "") ? returnDate : undefined,
    pickup_method: /^(DELIVERY|COLLECTION|UNKNOWN)$/.test(pickupMethod ?? "") ? pickupMethod!.toLowerCase() : undefined,
    return_method: /^(DELIVERY|COLLECTION|UNKNOWN)$/.test(returnMethod ?? "") ? returnMethod!.toLowerCase() : undefined,
    status: /^(ACTIVE|CANCELLED)$/.test(status ?? "") ? status as "ACTIVE" | "CANCELLED" : undefined,
    confidence: /^(HIGH|LOW)$/.test(confidence ?? "") ? confidence as "HIGH" | "LOW" : undefined,
    notes: lineValue(raw, "NOTES"),
  };
}
