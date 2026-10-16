import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/** Candidates for one handoff day, retaining the dashboard's source cutoff. */
export async function loadHandoffReservations(
  ctx: QueryCtx,
  targetDate: string,
  startCutoff: string,
  accountSlug: string | null,
): Promise<Doc<"reservations">[]> {
  // Agreed dates override provider dates. Read both pairs, then let the caller
  // apply the same effective-date predicates as before. These indexes also
  // avoid cancelled history and unrelated future reservations.
  const groups = await Promise.all([
    ctx.db.query("reservations").withIndex("by_status_pickup_date", (q) =>
      q.eq("status", "confirmed").eq("pickup_date", targetDate),
    ).collect(),
    ctx.db.query("reservations").withIndex("by_status_start_date", (q) =>
      q.eq("status", "confirmed").eq("start_date", targetDate),
    ).collect(),
    ctx.db.query("reservations").withIndex("by_status_return_date", (q) =>
      q.eq("status", "confirmed").eq("return_date", targetDate),
    ).collect(),
    ctx.db.query("reservations").withIndex("by_status_end_date", (q) =>
      q.eq("status", "confirmed").eq("end_date", targetDate),
    ).collect(),
  ]);
  const unique = new Map<string, Doc<"reservations">>();
  for (const row of groups.flat()) {
    if (row.start_date === undefined || row.start_date < startCutoff) continue;
    if (accountSlug && row.account_slug !== accountSlug) continue;
    unique.set(row._id, row);
  }
  // Preserve the original by_start_date order for equal-time stable sorting.
  return [...unique.values()].sort((a, b) =>
    (a.start_date ?? "").localeCompare(b.start_date ?? "") ||
    a._creationTime - b._creationTime,
  );
}
