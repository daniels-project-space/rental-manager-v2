/**
 * Wave 4 — polling_runs audit table accessors.
 *
 * Written by the Mastra `hygglo_poll` workflow on every cycle:
 *   - `startRun()` opens a "running" row at workflow start
 *   - `completeRun()` patches it on success/failure in the finally block
 *
 * Public `getRecent` powers the future admin "last poll" surface.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * NOTE: `startRun` / `completeRun` are plain `mutation` (not `internalMutation`)
 * so the Mastra workflow can invoke them via `ConvexHttpClient`. Auth is
 * enforced at the Next.js API gateway in front of the workflow trigger.
 */
export const startRun = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.insert("polling_runs", {
      startedAt: Date.now(),
      status: "running",
      newRentalsCount: 0,
      decisionsGeneratedCount: 0,
      mvRefreshesTriggered: [],
      affectedAccounts: [],
    });
  },
});

export const completeRun = mutation({
  args: {
    runId: v.id("polling_runs"),
    status: v.union(v.literal("ok"), v.literal("error")),
    newRentalsCount: v.number(),
    decisionsGeneratedCount: v.number(),
    mvRefreshesTriggered: v.array(v.string()),
    affectedAccounts: v.array(v.string()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { runId, ...patch } = args;
    await ctx.db.patch(runId, { ...patch, completedAt: Date.now() });
  },
});

export const getRecent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    return await ctx.db
      .query("polling_runs")
      .withIndex("by_startedAt")
      .order("desc")
      .take(limit ?? 20);
  },
});
