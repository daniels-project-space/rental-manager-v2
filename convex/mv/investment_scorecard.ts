/**
 * MV: mv_investment_scorecard (pass 11b, 2026-05-25)
 *
 * Wraps revenue.getInvestmentScorecard. Per Convex billing: ~120GB/month.
 * Reads all items + 2y reservations to compute 9 scalars.
 *
 * Refresher: daily. acquisition_cost rarely changes; lifetime revenue
 * drift is tolerable for 24h.
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
  const slugs: Array<{ key: string; arg: string | null }> = [
    { key: ACCOUNT_ALL, arg: null },
    ...ACCOUNTS.map((s) => ({ key: s, arg: s })),
  ];
  let written = 0;
  for (const { key, arg } of slugs) {
    const payload = await ctx.runQuery(api.revenue.getInvestmentScorecard, {
      accountSlug: arg,
      _bypassMv: true,
    });
    await ctx.runMutation(anyApi.mv.investment_scorecard.write, {
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
      .query("mv_investment_scorecard")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    if (existing) await ctx.db.patch(existing._id, { payload, generatedAt });
    else await ctx.db.insert("mv_investment_scorecard", { account, payload, generatedAt });
    return { ok: true };
  },
});

export const get = query({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const key = account ?? ACCOUNT_ALL;
    return await ctx.db
      .query("mv_investment_scorecard")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
  },
});
