/**
 * Phase 18.2 — MV master refresher.
 *
 * Consolidates the six per-MV cron entries into two batches:
 *   • refreshFast   — utilization_today + upcoming_returns (30 min cadence,
 *                     tight SLA for the Active widget + returns surface)
 *   • refreshSlow   — daily_briefing + top_earners + purchase_signals +
 *                     churn_risk (daily cadence; all slow-moving aggregates)
 *
 * NOTE on shared-collect optimisation:
 * The biggest potential win — reading `reservations` once and passing the
 * in-memory array to each pure compute — was scoped out of this PR because
 * each MV file's `refresh` is a tangled internalMutation with its own
 * account loop, denial-record queries, and singleton write logic. Refactoring
 * those to pure `compute(reservations, ...)` functions would blow the 200
 * LOC budget. This master delegates to existing `refresh` mutations, so we
 * only consolidate the cron entries and the shared-collect refactor stays
 * a candidate for the next PR.
 *
 * Each delegated refresh runs in its own Convex mutation transaction, so a
 * failure in one MV does not roll back the others.
 */
import { v } from "convex/values";
import { internalAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";

type MvName =
  | "daily_briefing"
  | "top_earners"
  | "purchase_signals"
  | "churn_risk"
  | "utilization"
  | "upcoming_returns";

const FAST_MVS: MvName[] = ["utilization", "upcoming_returns"];
const SLOW_MVS: MvName[] = [
  "daily_briefing",
  "top_earners",
  "purchase_signals",
  "churn_risk",
];

async function runOne(
  ctx: ActionCtx,
  name: MvName,
): Promise<{ name: MvName; ok: boolean; error?: string }> {
  try {
    switch (name) {
      case "daily_briefing":
        await ctx.runMutation(internal.mv.daily_briefing.refresh, {});
        break;
      case "top_earners":
        await ctx.runMutation(internal.mv.top_earners.refresh, {});
        break;
      case "purchase_signals":
        await ctx.runMutation(internal.mv.purchase_signals.refresh, {});
        break;
      case "churn_risk":
        await ctx.runMutation(internal.mv.churn_risk.refresh, {});
        break;
      case "utilization":
        await ctx.runMutation(internal.mv.utilization.refresh, {});
        break;
      case "upcoming_returns":
        await ctx.runMutation(internal.mv.upcoming_returns.refresh, {});
        break;
    }
    return { name, ok: true };
  } catch (err) {
    return { name, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const refreshFast = internalAction({
  args: { only: v.optional(v.array(v.string())) },
  handler: async (ctx, { only }) => {
    const targets = only && only.length > 0
      ? FAST_MVS.filter((m) => only.includes(m))
      : FAST_MVS;
    const results = [];
    for (const name of targets) results.push(await runOne(ctx, name));
    return { batch: "fast", results };
  },
});

export const refreshSlow = internalAction({
  args: { only: v.optional(v.array(v.string())) },
  handler: async (ctx, { only }) => {
    const targets = only && only.length > 0
      ? SLOW_MVS.filter((m) => only.includes(m))
      : SLOW_MVS;
    const results = [];
    for (const name of targets) results.push(await runOne(ctx, name));
    return { batch: "slow", results };
  },
});
