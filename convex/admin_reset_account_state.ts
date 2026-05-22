import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const resetAccount = internalMutation({
  args: { account: v.string() },
  handler: async (ctx, { account }) => {
    const row = await ctx.db.query("account_state")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    if (!row) return { ok: false, reason: "not_found" };
    await ctx.db.patch(row._id, {
      mode: "active",
      consecutiveFailures: 0,
      lastError: undefined,
      modeChangedAt: Date.now(),
    });
    return { ok: true, was: row.mode, account };
  },
});
