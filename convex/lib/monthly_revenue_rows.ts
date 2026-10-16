import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { ReservationRow } from "./reservations/predicates";

function sourceWindow(ctx: QueryCtx, field: "start_date" | "pickup_date", start: string, end: string, account: string | null) {
  if (account) {
    return field === "start_date"
      ? ctx.db.query("reservations").withIndex("by_account_status_start_date", (q) =>
        q.eq("account_slug", account).eq("status", "completed").gte("start_date", start).lte("start_date", end)).collect()
      : ctx.db.query("reservations").withIndex("by_account_status_pickup_date", (q) =>
        q.eq("account_slug", account).eq("status", "completed").gte("pickup_date", start).lte("pickup_date", end)).collect();
  }
  return field === "start_date"
    ? ctx.db.query("reservations").withIndex("by_status_start_date", (q) =>
      q.eq("status", "completed").gte("start_date", start).lte("start_date", end)).collect()
    : ctx.db.query("reservations").withIndex("by_status_pickup_date", (q) =>
      q.eq("status", "completed").gte("pickup_date", start).lte("pickup_date", end)).collect();
}

export function revenueFactRow(row: Doc<"reservation_revenue_facts">): ReservationRow {
  return { _id: row.source_id, _creationTime: row.source_creation_time, status: row.status,
    start_date: row.start_date, end_date: row.end_date, pickup_date: row.pickup_date,
    account_slug: row.account_slug, renter_id: row.renter_id, renter_name: row.renter_name,
    hygglo_order_id: row.hygglo_order_id, v1_rental_id: row.v1_rental_id,
    is_obsolete: row.is_obsolete, order_step: row.order_step, net_to_owner_gbp: row.net_to_owner_gbp };
}

/** One compact month-index read after a complete source and orphan audit. */
export async function loadCompletedMonthlyRows(ctx: QueryCtx, start: string, end: string, account: string | null) {
  const original = async () => {
    const [startRows, pickupRows] = await Promise.all([
      sourceWindow(ctx, "start_date", start, end, account), sourceWindow(ctx, "pickup_date", start, end, account),
    ]);
    return { startRows: startRows as ReservationRow[], pickupRows: pickupRows as ReservationRow[] };
  };
  const ready = await ctx.db.query("reservation_revenue_ready").withIndex("by_key", (q) => q.eq("key", "v1")).first();
  if (!ready?.ready) return original();
  const firstMonth = start.slice(0, 7), lastMonth = end.slice(0, 7);
  const facts = account
    ? await ctx.db.query("reservation_revenue_facts").withIndex("by_account_month", (q) =>
      q.eq("account_slug", account).gte("effective_month", firstMonth).lte("effective_month", lastMonth)).collect()
    : await ctx.db.query("reservation_revenue_facts").withIndex("by_month", (q) =>
      q.gte("effective_month", firstMonth).lte("effective_month", lastMonth)).collect();
  const rows = facts.map(revenueFactRow);
  const dateShape = /^\d{4}-\d{2}-\d{2}$/;
  if (rows.some((row) => !dateShape.test(row.start_date!) ||
    row.pickup_date !== undefined && !dateShape.test(row.pickup_date))) return original();
  const compare = (field: "start_date" | "pickup_date") => (a: ReservationRow, b: ReservationRow) =>
    (a[field] ?? "").localeCompare(b[field] ?? "") || a._creationTime - b._creationTime;
  const startRows = rows.filter((row) => row.start_date! >= start && row.start_date! <= end).sort(compare("start_date"));
  const pickupRows = rows.filter((row) => row.pickup_date !== undefined && row.pickup_date >= start && row.pickup_date <= end).sort(compare("pickup_date"));
  // Database tie order is not inferred from a rendered document ID. Preserve
  // original index reads for the rare fully tied source-date/creation keys.
  if ([startRows, pickupRows].some((group, i) => group.some((row, j) =>
    j > 0 && compare(i === 0 ? "start_date" : "pickup_date")(group[j - 1], row) === 0))) return original();
  return { startRows, pickupRows };
}
