/**
 * MV: mv_stats_drawer (phase 7d, 2026-05-24)
 *
 * Wraps the 16-card getStatsDrawerData megaquery in a per-account cache.
 * Refresher runs the existing internal handler for each slug + stores the
 * full payload as v.any(). Dashboard subscriptions read a single indexed
 * row instead of re-running the 8-collect + 16-card compute on every
 * reservation mutation.
 *
 * Refreshed by master.refreshFast (hourly). Three rows total:
 * "all" (accountSlug=null), "dbcinema", "leo".
 *
 * Cold-start fallback: the public getStatsDrawerData query in
 * convex/dashboard.ts falls back to the internal live compute for the
 * first cron tick after deploy.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, query } from "../_generated/server";
import { api } from "../_generated/api";
import { anyApi } from "convex/server";
import { ACCOUNTS, ACCOUNT_ALL } from "./constants";

/**
 * Standalone refresher — direct invocation path (manual ops, cold-start
 * population). The hot path lives in master.refreshFast which calls this
 * action's `refreshAll` helper directly to avoid the extra action hop.
 */
export const refresh = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: true; written: number; durationMs: number }> => {
    return await refreshAll(ctx);
  },
});

/**
 * Shared compute used by both the standalone refresh action and the master
 * refreshFast orchestrator. Calls the live getStatsDrawerData per account
 * and writes the payloads in a single mutation per account.
 */
export async function refreshAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
): Promise<{ ok: true; written: number; durationMs: number }> {
  const startedAt = Date.now();
  const slugs: Array<{ key: string; arg: string | null }> = [
    { key: ACCOUNT_ALL, arg: null },
    ...ACCOUNTS.map((s) => ({ key: s, arg: s })),
  ];
  let written = 0;
  for (const { key, arg } of slugs) {
    const payload = await ctx.runQuery(api.dashboard.getStatsDrawerData, {
      accountSlug: arg,
      _bypassMv: true,
    });
    await ctx.runMutation(anyApi.mv.stats_drawer.write, {
      account: key,
      payload,
      generatedAt: startedAt,
    });
    written += 1;
  }
  return { ok: true, written, durationMs: Date.now() - startedAt };
}

export const write = internalMutation({
  args: {
    account: v.string(),
    payload: v.any(),
    generatedAt: v.number(),
  },
  handler: async (ctx, { account, payload, generatedAt }) => {
    const existing = await ctx.db
      .query("mv_stats_drawer")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { payload, generatedAt });
    } else {
      await ctx.db.insert("mv_stats_drawer", { account, payload, generatedAt });
    }
    return { ok: true };
  },
});

/**
 * Reader — returns the cached payload for an accountSlug (or "all").
 * Returns null when MV not yet populated; callers should fall back to live
 * compute in that case.
 */
export const get = query({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const key = account ?? ACCOUNT_ALL;
    const row = await ctx.db
      .query("mv_stats_drawer")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
    return row;
  },
});
