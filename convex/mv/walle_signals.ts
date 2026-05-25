/**
 * MV: mv_walle_signals (pass 11h, 2026-05-25)
 *
 * Unified wrap-and-cache for the 3 WallE-widget queries:
 *   - dashboard_insights.getActiveConflicts
 *   - dashboard_insights.getRevenueDelta
 *   - dashboard_insights.getUtilizationDelta
 *
 * Even after pass-8c added by_start_date indexed scans, each call still
 * reads ~250 reservation rows × ~50KB rich payload = ~12.5MB per re-eval.
 * Three queries × three widget subscribers × every reservation mutation
 * = multi-GB/day. The 3 underlying handlers share the same input data
 * window (60d reservations); combining into one MV row eliminates the
 * triple read.
 *
 * Refresher: daily via master.refreshSlow. WallE freshness is best-effort
 * (conflicts + deltas drift slowly); 24h staleness is acceptable for
 * widget-level signals.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, query } from "../_generated/server";
import { api } from "../_generated/api";
import { anyApi } from "convex/server";
import { ACCOUNTS, ACCOUNT_ALL } from "./constants";

export const refresh = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: true; written: number; durationMs: number }> => {
    return await refreshAll(ctx);
  },
});

export async function refreshAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
): Promise<{ ok: true; written: number; durationMs: number }> {
  const startedAt = Date.now();
  // WallE queries are account-agnostic (none take an accountSlug arg).
  // Cache under "all" only.
  const slug = ACCOUNT_ALL;
  const [activeConflicts, revenueDelta, utilizationDelta] = await Promise.all([
    ctx.runQuery(api.dashboard_insights.getActiveConflicts, { _bypassMv: true }),
    ctx.runQuery(api.dashboard_insights.getRevenueDelta, { _bypassMv: true }),
    ctx.runQuery(api.dashboard_insights.getUtilizationDelta, { _bypassMv: true }),
  ]);
  await ctx.runMutation(anyApi.mv.walle_signals.write, {
    account: slug,
    activeConflicts,
    revenueDelta,
    utilizationDelta,
    generatedAt: startedAt,
  });
  // suppress unused ACCOUNTS — kept for future per-account variants.
  void ACCOUNTS;
  return { ok: true, written: 1, durationMs: Date.now() - startedAt };
}

export const write = internalMutation({
  args: {
    account: v.string(),
    activeConflicts: v.any(),
    revenueDelta: v.any(),
    utilizationDelta: v.any(),
    generatedAt: v.number(),
  },
  handler: async (ctx, { account, activeConflicts, revenueDelta, utilizationDelta, generatedAt }) => {
    const existing = await ctx.db
      .query("mv_walle_signals")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    const fields = { activeConflicts, revenueDelta, utilizationDelta, generatedAt };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("mv_walle_signals", { account, ...fields });
    return { ok: true };
  },
});

export const get = query({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const key = account ?? ACCOUNT_ALL;
    return await ctx.db
      .query("mv_walle_signals")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
  },
});
