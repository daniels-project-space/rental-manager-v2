// Pure helpers for double-booking detection.
// Extracted from convex/dashboard.ts so the date-sweep logic can be unit tested.

export interface DBRow {
  start_date: string;
  end_date: string;
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

export const effEnd = (
  r: { end_date: string; order_step?: string | null; status?: string | null },
  today: string,
): string => {
  const e = r.end_date;
  if (
    (r.order_step === "RETURNED" || r.order_step === "DELIVERED") &&
    r.status === "confirmed"
  ) {
    const graceCutoff = isoNDaysAgo(OVERDUE_GRACE_DAYS, today);
    if (e >= graceCutoff) return e > today ? e : today;
    return e;
  }
  return e;
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
  const startDates = rows.map((r) => r.start_date);
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
      (r) => r.start_date <= d && effEnd(r, today) >= d,
    );
    const qtySum = overlapping.reduce((s, r) => s + r.qty, 0);
    if (qtySum > worstCount) {
      worstCount = qtySum;
      worstDay = d;
    }
  }

  const overlappingSet = rows.filter(
    (r) => r.start_date <= worstDay && effEnd(r, today) >= worstDay,
  );
  const earliestEnd = overlappingSet
    .map((r) => effEnd(r, today))
    .sort()[0] ?? "";

  return { worstDay, worstCount, overlapping: overlappingSet, earliestEnd };
}
