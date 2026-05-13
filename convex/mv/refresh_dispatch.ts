/**
 * Wave 4 — public dispatcher for MV refreshers.
 *
 * The Mastra `hygglo_poll` workflow runs in Node (Vercel/local) and uses
 * `ConvexHttpClient`, which can only call `mutation` / `action`, NOT
 * `internalMutation`. The MV `refresh` functions themselves stay internal
 * (cron-only callers should not have to authenticate). This file is the
 * thin public surface the workflow targets — it just runs the matching
 * internal mutation by name.
 *
 * SECURITY: This is a public action with no auth check today (matches the
 * polling-workflow's trust model — pre-Vercel-deploy it runs from a trusted
 * Trigger.dev task). Add auth on the Next.js API gateway before exposing.
 */
import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";

const MV_NAMES = [
  "daily_briefing",
  "top_earners",
  "purchase_signals",
  "churn_risk",
  "utilization",
  "upcoming_returns",
] as const;
type MvName = (typeof MV_NAMES)[number];

export const refreshOne = action({
  args: {
    mvName: v.string(),
    account: v.optional(v.string()),
  },
  handler: async (ctx, { mvName, account }): Promise<{ ok: boolean; rowsAffected?: number; durationMs?: number; error?: string }> => {
    if (!MV_NAMES.includes(mvName as MvName)) {
      return { ok: false, error: `unknown_mv:${mvName}` };
    }
    const targetArg = account ? { account } : {};
    switch (mvName as MvName) {
      case "daily_briefing":
        return await ctx.runMutation(internal.mv.daily_briefing.refresh, targetArg);
      case "top_earners":
        return await ctx.runMutation(internal.mv.top_earners.refresh, targetArg);
      case "purchase_signals":
        return await ctx.runMutation(internal.mv.purchase_signals.refresh, targetArg);
      case "churn_risk":
        return await ctx.runMutation(internal.mv.churn_risk.refresh, targetArg);
      case "utilization":
        return await ctx.runMutation(internal.mv.utilization.refresh, targetArg);
      case "upcoming_returns":
        return await ctx.runMutation(internal.mv.upcoming_returns.refresh, targetArg);
    }
  },
});
