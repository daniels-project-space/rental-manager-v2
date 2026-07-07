/**
 * MV: mv_ai_insights (2026-07-07)
 *
 * Wraps the getInsights (AI Investment Insights) query in a per-account cache.
 * The live query scanned up to a FULL YEAR of fat reservation docs on every
 * reactive re-run — and it's reactive on the reservations table, so the 5-min
 * poller re-triggered it constantly (×every open dashboard tab) to produce ~5
 * slow-moving analytics cards. ~24 GB/mo of Convex DB bandwidth for static text.
 *
 * Refreshed once daily by master.refreshSlow (analytics windows are 30/60/90d,
 * so 24h staleness is invisible). Reader falls back to the live compute on a
 * cold MV (first tick after deploy / table wipe).
 *
 * Mirrors the mv/stats_drawer.ts wrap-and-cache pattern.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, query } from "../_generated/server";
import { api } from "../_generated/api";
import { anyApi } from "convex/server";
import { ACCOUNTS, ACCOUNT_ALL } from "./constants";

/** Standalone refresher — direct invocation path (manual ops, cold-start). */
export const refresh = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: true; written: number; durationMs: number }> => {
    return await refreshAll(ctx);
  },
});

/**
 * Shared compute used by the standalone action and master.refreshSlow. Runs the
 * live getInsights per account (with _bypassMv so it doesn't read its own cache)
 * and stores the returned card array.
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: any = await ctx.runQuery(api.ai_insights.getInsights, {
      accountSlug: arg,
      _bypassMv: true,
    });
    await ctx.runMutation(anyApi.mv.ai_insights.write, {
      account: key,
      payload,
      generatedAt: startedAt,
    });
    written += 1;
  }
  return { ok: true, written, durationMs: Date.now() - startedAt };
}

export const write = internalMutation({
  args: { account: v.string(), payload: v.any(), generatedAt: v.number() },
  handler: async (ctx, { account, payload, generatedAt }) => {
    const existing = await ctx.db
      .query("mv_ai_insights")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { payload, generatedAt });
    } else {
      await ctx.db.insert("mv_ai_insights", { account, payload, generatedAt });
    }
    return { ok: true };
  },
});

/** Reader — cached card array for an accountSlug (or "all"); null when cold. */
export const get = query({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const key = account ?? ACCOUNT_ALL;
    return await ctx.db
      .query("mv_ai_insights")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
  },
});
