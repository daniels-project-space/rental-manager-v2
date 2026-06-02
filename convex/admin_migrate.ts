import { v } from "convex/values";
import { mutation } from "./_generated/server";

/**
 * One-shot: clear order_step on all reservations so the next poll cycle
 * writes the new highest-completed step (replacing the old active-step
 * semantics). Required because isStepRegression would otherwise reject
 * the downgrade from active-step values to highest-completed values.
 */
export const clearAllOrderSteps = mutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("reservations").collect(); // check-patterns:ok — one-off migration (manual run)
    let cleared = 0;
    for (const r of rows) {
      if ((r as any).order_step !== undefined) {
        await ctx.db.patch(r._id, { order_step: undefined });
        cleared++;
      }
    }
    return { total: rows.length, cleared };
  },
});
