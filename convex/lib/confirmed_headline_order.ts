import type { ReservationRow } from "./reservations/predicates";

const fields = ["end_date", "return_date", "pickup_date", "start_date"] as const;

/** Reuse the complete cohort while preserving the final pickup ordering. */
export function confirmedPickupWindow<T extends ReservationRow>(rows: T[], start: string, end: string): T[] | null {
  const compare = (a: T, b: T) => a.pickup_date!.localeCompare(b.pickup_date!) || a._creationTime - b._creationTime;
  const selected = rows.filter((row) => row.pickup_date !== undefined && row.pickup_date >= start && row.pickup_date <= end).sort(compare);
  // The caller sorts by pickup date and creation time. A tie retains the
  // database input order, including its start-date suffix; query it directly.
  if (selected.some((row, i) => i > 0 && compare(selected[i - 1], row) === 0)) return null;
  return selected;
}

/** Reproduce the former four-index union without rereading overlapping rows. */
export function confirmedHeadlineOrder<T extends ReservationRow>(rows: T[], today: string): T[] | null {
  const ordered = new Map<string, T>();
  for (const field of fields) {
    const compare = (a: T, b: T) => {
      const av = a[field]!, bv = b[field]!;
      const primary = av < bv ? -1 : av > bv ? 1 : 0;
      // The pickup indexes include start_date before _creationTime.
      const as = a.start_date, bs = b.start_date;
      const secondary = field !== "pickup_date" || as === bs ? 0
        : as === undefined ? -1 : bs === undefined ? 1 : as < bs ? -1 : 1;
      return primary || secondary || a._creationTime - b._creationTime;
    };
    const eligible = rows.filter((row) => row[field] !== undefined && row[field]! >= today).sort(compare);
    // Preserve the database's tie order rather than inferring it from IDs.
    if (eligible.some((row, i) => i > 0 && compare(eligible[i - 1], row) === 0)) return null;
    for (const row of eligible) ordered.set(row._id, row);
  }
  // Older members still participate in complete logical rental chains.
  for (const row of rows) if (!ordered.has(row._id)) ordered.set(row._id, row);
  return [...ordered.values()];
}
