/**
 * One-shot backfill — repairs reservations that were incorrectly auto-demoted
 * to `status=completed` by the stale-confirmed cron, even though the renter
 * still has the gear (`order_step=RETURNED`).
 *
 * Hygglo keeps such rentals in `current` until the owner verifies the return,
 * so they MUST remain `status=confirmed` so the dashboard double-booking
 * detector (which only counts `status=confirmed`) can see them.
 *
 * Idempotent: re-running after the cron-guard fix simply finds zero rows.
 *
 * Run:
 *   npx convex run admin_backfill_stale_completed:run '{}'
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("reservations").collect();
    let patched = 0;
    const hygglo_order_ids: string[] = [];
    for (const r of rows) {
      if (r.status !== "completed") continue;
      if (r.order_step !== "RETURNED") continue;
      await ctx.db.patch(r._id, { status: "confirmed" });
      patched++;
      if (r.hygglo_order_id) hygglo_order_ids.push(String(r.hygglo_order_id));
    }
    return { patched, hygglo_order_ids };
  },
});
