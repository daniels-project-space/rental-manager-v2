/**
 * Effective date/time helpers for calendar placement and active-rental display.
 *
 * These honor AI-extracted / negotiated values (pickup_date, return_date,
 * pickup_time, return_time) over the raw Hygglo dates (start_date, end_date)
 * for DISPLAY and PLACEMENT purposes only. The raw Hygglo dates remain
 * canonical for invoicing/utilization and are never mutated.
 *
 * IMPORTANT: pickup_date / return_date are stored in the SAME date-only string
 * format ("YYYY-MM-DD") as start_date / end_date (see convex/schema.ts
 * reservations table — pickup_date ~227, return_date ~270, extracted via the
 * /\d{4}-\d{2}-\d{2}/ pattern in extract_booking_times.ts and validated against
 * start_date with date-tolerance). So existing string comparisons stay valid
 * and NO normalization is required here.
 *
 * NOTE: This is intentionally NOT the same as the conflict-detection helpers in
 * convex/lib/double_booking.ts (effStart/effEnd), which are earlier-only +
 * 7-day grace for availability checks. Those are left untouched.
 */

/** Reservation shape this module reads (loose by design — many call sites). */
export type EffectiveDateRow = {
  start_date?: string | null;
  end_date?: string | null;
  pickup_date?: string | null;
  return_date?: string | null;
  pickup_time?: string | null;
  return_time?: string | null;
};

/**
 * Effective pickup date: prefer the negotiated `pickup_date` (EITHER direction —
 * it may be earlier OR later than the Hygglo `start_date`), else fall back to
 * `start_date`. Returns the date-only "YYYY-MM-DD" string.
 */
export function displayPickupDate(r: EffectiveDateRow): string {
  return (r.pickup_date ?? r.start_date) ?? "";
}

/**
 * Effective return date: prefer AI-extracted `return_date` (e.g. extension
 * agreed in chat) over the raw Hygglo `end_date`. Consolidated from the former
 * `effectiveReturnDate` in convex/calendar.ts — behavior is identical.
 */
export function displayReturnDate(r: EffectiveDateRow): string {
  return (r.return_date ?? r.end_date) ?? "";
}

/** Negotiated pickup time ("HH:MM") if present, else null. */
export function displayPickupTime(r: EffectiveDateRow): string | null {
  return r.pickup_time ?? null;
}

/** Negotiated return time ("HH:MM") if present, else null. */
export function displayReturnTime(r: EffectiveDateRow): string | null {
  return r.return_time ?? null;
}
