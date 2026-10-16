import type { QueryCtx } from "../_generated/server";

/**
 * Return live rentals whose end dates intersect a recent window.
 *
 * Querying a start-date range first can read many unrelated reservations
 * before status and end-date filters discard them. The composite
 * status/end-date index applies those selective bounds in the database.
 * Keep the original start-date cutoff as a guard so callers retain the exact
 * result set of their previous bounded over-fetch.
 */
export async function liveReservationsEndingSince(
  ctx: Pick<QueryCtx, "db">,
  startCutoff: string,
  endCutoff: string,
) {
  const readStatus = (status: "confirmed" | "completed") =>
    ctx.db
      .query("reservations")
      .withIndex("by_status_end_date", (q) =>
        q.eq("status", status).gte("end_date", endCutoff),
      )
      .collect();
  const [confirmed, completed] = await Promise.all([
    readStatus("confirmed"),
    readStatus("completed"),
  ]);
  return [...confirmed, ...completed].filter(
    (r) => r.start_date !== undefined && r.start_date >= startCutoff,
  );
}
