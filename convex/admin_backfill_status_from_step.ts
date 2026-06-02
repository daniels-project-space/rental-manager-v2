/**
 * One-shot 2026-05-21: re-derive status for rows where the old
 * deriveStatusFromStep wrote status="completed" on current+RETURNED. Those
 * rentals' gear is still with the renter; they should be "confirmed" so the
 * active-rental widget picks them up.
 *
 * Strategy: any non-obsolete reservation with order_step=RETURNED whose
 * end_date is >= today flips to status="confirmed". Rows whose end_date
 * already passed stay as-is — the active widget filters them out via the
 * end_date predicate either way, and we don't want to re-open settled history.
 */
import { internalMutation } from "./_generated/server";

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    const all = await ctx.db.query("reservations").collect(); // check-patterns:ok — one-off admin backfill (manual run)
    let updated = 0;
    const samples: any[] = [];
    for (const r of all) {
      if (r.is_obsolete) continue;
      if (r.status !== "completed") continue;
      if (r.order_step !== "RETURNED") continue;
      if (!r.end_date || r.end_date < today) continue;
      await ctx.db.patch(r._id, { status: "confirmed" });
      updated++;
      if (samples.length < 10) {
        samples.push({
          renter: r.renter_name,
          account: r.account_slug,
          hygglo_order_id: r.hygglo_order_id,
          start_date: r.start_date,
          end_date: r.end_date,
        });
      }
    }
    return { today, updated, samples };
  },
});
