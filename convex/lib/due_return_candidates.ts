import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

/**
 * Load only confirmed rows that can reach the Return Hub's outstanding state.
 * Delivered and returned rows remain candidates regardless of date so the
 * caller retains its time-aware filtering. Legacy rows are only candidates
 * when their end date has passed, matching isOutstandingReturnState.
 */
export async function loadConfirmedReturnCandidates(
  ctx: QueryCtx,
  accountSlug: string | null,
  today: string,
): Promise<Doc<"reservations">[]> {
  const byStep = (step: "DELIVERED" | "RETURNED") =>
    ctx.db
      .query("reservations")
      .withIndex("by_status_order_step_end_date", (q) =>
        q.eq("status", "confirmed").eq("order_step", step),
      )
      .collect();

  const [delivered, returned, legacyDue] = await Promise.all([
    byStep("DELIVERED"),
    byStep("RETURNED"),
    ctx.db
      .query("reservations")
      .withIndex("by_status_order_step_end_date", (q) =>
        q.eq("status", "confirmed").eq("order_step", undefined).lte("end_date", today),
      )
      .collect(),
  ]);

  const unique = new Map<string, Doc<"reservations">>();
  for (const row of [...delivered, ...returned, ...legacyDue]) {
    if (!accountSlug || row.account_slug === accountSlug) unique.set(String(row._id), row);
  }
  // Match the creation-time ordering of the old status-index scan so equal-
  // date Return Hub cards keep a stable order after grouping.
  return Array.from(unique.values()).sort((a, b) => a._creationTime - b._creationTime);
}
