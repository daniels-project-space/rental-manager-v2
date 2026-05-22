// Pure helpers for double-booking detection.
// Extracted from convex/dashboard.ts so the date-sweep logic can be unit tested.

export interface DBRow {
  start_date: string;
  end_date: string;
  /** Optional override capturing day-before evening pickups. When set and
   *  earlier than start_date, the gear is treated as out from this date. */
  pickup_date?: string | null;
  /** Optional override capturing morning-after returns. When set and later
   *  than end_date, the gear is treated as out through this date. */
  return_date?: string | null;
  order_step?: string | null;
  status?: string | null;
  qty: number; // qty of the item this row contributes
}

// Days of grace after end_date during which we still treat gear as "out".
// Beyond this, RETURNED/DELIVERED+confirmed rentals are presumed actually
// returned even if not yet status-completed by the cron. Tuned 2026-05-20
// to suppress phantom conflicts from ancient overdue rentals.
const OVERDUE_GRACE_DAYS = 7;

const isoNDaysAgo = (n: number, today: string): string => {
  const t = new Date(today + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() - n);
  return t.toISOString().slice(0, 10);
};

/**
 * Earliest date on which this rental occupies the gear. Normally start_date,
 * but a renter who arranges to pick up the evening BEFORE the rental window
 * makes the gear unavailable from that earlier date. We honour pickup_date
 * iff it precedes start_date (extracted from chat via extract_booking_times).
 */
export const effStart = (r: {
  start_date: string;
  pickup_date?: string | null;
}): string => {
  if (r.pickup_date && r.pickup_date < r.start_date) return r.pickup_date;
  return r.start_date;
};

/**
 * Latest date on which this rental occupies the gear.
 *
 * Two extensions beyond the booking's end_date:
 *   1. Morning-after returns: return_date later than end_date (renter took
 *      pickup the day before evening or returns next morning) extends out.
 *   2. Overdue grace: a RETURNED/DELIVERED row whose end_date has just
 *      passed gets treated as still-out through today, capped at
 *      OVERDUE_GRACE_DAYS. Beyond that we presume actually returned.
 */
export const effEnd = (
  r: {
    end_date: string;
    return_date?: string | null;
    order_step?: string | null;
    status?: string | null;
  },
  today: string,
): string => {
  // (1) Morning-after return: trust the chat-extracted return_date when later.
  const base =
    r.return_date && r.return_date > r.end_date ? r.return_date : r.end_date;
  // (2) Overdue grace: only relevant when the rental's booked window already
  // ended. We extend up to today (capped at OVERDUE_GRACE_DAYS past end).
  if (
    (r.order_step === "RETURNED" || r.order_step === "DELIVERED") &&
    r.status === "confirmed"
  ) {
    const graceCutoff = isoNDaysAgo(OVERDUE_GRACE_DAYS, today);
    if (base >= graceCutoff) return base > today ? base : today;
    return base;
  }
  return base;
};

/**
 * Worst-day overlap on a single item.
 * Returns the worst date and qty-sum on that date, plus the overlapping rows
 * (with their effective end dates applied).
 */
export function computeWorstOverlap(
  rows: DBRow[],
  today: string,
  horizonEnd: string,
): {
  worstDay: string;
  worstCount: number;
  overlapping: DBRow[];
  earliestEnd: string;
} {
  const scanFrom = today;
  const scanTo = horizonEnd;
  const startDates = rows.map((r) => effStart(r));
  const endDates = rows.map((r) => effEnd(r, today));
  const candidates = Array.from(
    new Set<string>(
      [scanFrom, ...startDates, ...endDates].filter(
        (d) => d >= scanFrom && d <= scanTo,
      ),
    ),
  ).sort();

  let worstDay = "";
  let worstCount = 0;
  for (const d of candidates) {
    const overlapping = rows.filter(
      (r) => effStart(r) <= d && effEnd(r, today) >= d,
    );
    const qtySum = overlapping.reduce((s, r) => s + r.qty, 0);
    if (qtySum > worstCount) {
      worstCount = qtySum;
      worstDay = d;
    }
  }

  const overlappingSet = rows.filter(
    (r) => effStart(r) <= worstDay && effEnd(r, today) >= worstDay,
  );
  const earliestEnd = overlappingSet
    .map((r) => effEnd(r, today))
    .sort()[0] ?? "";

  return { worstDay, worstCount, overlapping: overlappingSet, earliestEnd };
}
