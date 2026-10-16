import type { ReservationRow } from "./reservations/predicates";

const fields = ["end_date", "return_date", "pickup_date", "start_date"] as const;

/** Reproduce the former four-index union without rereading overlapping rows. */
export function confirmedHeadlineOrder<T extends ReservationRow>(rows: T[], today: string): T[] | null {
  const ordered = new Map<string, T>();
  for (const field of fields) {
    const compare = (a: T, b: T) => {
      const av = a[field]!, bv = b[field]!;
      return (av < bv ? -1 : av > bv ? 1 : 0) || a._creationTime - b._creationTime;
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
