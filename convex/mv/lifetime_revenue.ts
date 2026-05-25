/**
 * MV: mv_lifetime_revenue (pass 11a, 2026-05-25)
 *
 * Wraps revenue.getLifetimeByMonth. Each live call collects the full
 * reservation history + AI decision/audit + insurance + historical
 * revenue. Per Convex billing: ~100GB/month of bandwidth.
 *
 * Refresher: daily via master.refreshSlow. Past months are immutable;
 * current month + AI attribution drift slowly, so 24h staleness is fine.
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
    const payload = await ctx.runQuery(api.revenue.getLifetimeByMonth, {
      accountSlug: arg,
      _bypassMv: true,
    });
    await ctx.runMutation(anyApi.mv.lifetime_revenue.write, {
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
      .query("mv_lifetime_revenue")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    if (existing) await ctx.db.patch(existing._id, { payload, generatedAt });
    else await ctx.db.insert("mv_lifetime_revenue", { account, payload, generatedAt });
    return { ok: true };
  },
});

export const get = query({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const key = account ?? ACCOUNT_ALL;
    return await ctx.db
      .query("mv_lifetime_revenue")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
  },
});
