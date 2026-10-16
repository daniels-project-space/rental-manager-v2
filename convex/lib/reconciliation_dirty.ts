import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/** Mark a reservation for the poller's next bounded hold reconciliation. */
export async function markReservationDirty(
  ctx: MutationCtx,
  reservationId: Id<"reservations">,
  accountSlug: string,
): Promise<void> {
  const existing = await ctx.db
    .query("reservation_reconcile_dirty")
    .withIndex("by_reservation", (q) => q.eq("reservation_id", reservationId))
    .first();
  const version = Math.max(Date.now(), (existing?.version ?? 0) + 1);
  if (existing) {
    await ctx.db.patch(existing._id, { account_slug: accountSlug, version });
  } else {
    await ctx.db.insert("reservation_reconcile_dirty", {
      reservation_id: reservationId,
      account_slug: accountSlug,
      version,
    });
  }
}
