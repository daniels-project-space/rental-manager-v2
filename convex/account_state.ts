import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// ── Queries ───────────────────────────────────────────────────

/**
 * Returns the account_state row for a given account, or null if none exists.
 */
export const get = query({
  args: { account: v.string() },
  handler: async (ctx, { account }) => {
    return await ctx.db
      .query("account_state")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
  },
});

/**
 * Returns all account_state rows (for admin/status view).
 */
export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("account_state").collect();
  },
});

// ── Mutations ─────────────────────────────────────────────────

/**
 * Upserts the polling state for an account after each poll attempt.
 * - succeeded=true: clears failures, reactivates if paused.
 * - succeeded=false: increments consecutiveFailures; pauses at >= 5.
 */
export const upsert = mutation({
  args: {
    account: v.string(),
    succeeded: v.boolean(),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, { account, succeeded, errorMessage }): Promise<void> => {
    const existing = await ctx.db
      .query("account_state")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();

    const now = Date.now();

    if (existing) {
      if (succeeded) {
        const modeChanged = existing.mode === "paused";
        await ctx.db.patch(existing._id, {
          lastSuccessfulPollAt: now,
          consecutiveFailures: 0,
          lastError: undefined,
          mode: modeChanged ? "active" : existing.mode,
          modeChangedAt: modeChanged ? now : existing.modeChangedAt,
        });
      } else {
        const newFailures = existing.consecutiveFailures + 1;
        const shouldPause = newFailures >= 5;
        await ctx.db.patch(existing._id, {
          consecutiveFailures: newFailures,
          lastError: errorMessage,
          mode: shouldPause ? "paused" : existing.mode,
          modeChangedAt: shouldPause ? now : existing.modeChangedAt,
        });
      }
    } else {
      await ctx.db.insert("account_state", {
        account,
        lastSuccessfulPollAt: succeeded ? now : 0,
        consecutiveFailures: succeeded ? 0 : 1,
        mode: "active",
        modeChangedAt: now,
        lastError: succeeded ? undefined : errorMessage,
      });
    }
  },
});
