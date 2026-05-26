/**
 * MV: mv_due_returns (pass 12a, 2026-05-26)
 *
 * Wraps reservations.getDueReturns in a per-account cache. Live handler does
 * `by_status("confirmed").collect()` (~250 rich rows × ~50KB each) plus N+1
 * renter lookups per call. WallESignals (inside EAGER StatsGrid) subscribes
 * on every cold-mount, so every reservation mutation triggers a reactive
 * re-eval across all open dashboard tabs.
 *
 * Refresher: hourly via master.refreshFast. Day-boundary staleness OK — the
 * "due today" set only shifts at midnight, and hourly refresh keeps the
 * window within an hour of correct.
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
    const payload = await ctx.runQuery(
      api.reservations.getDueReturns,
      { accountSlug: arg, _bypassMv: true },
    );
    await ctx.runMutation(anyApi.mv.due_returns.write, {
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
      .query("mv_due_returns")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { payload, generatedAt });
    } else {
      await ctx.db.insert("mv_due_returns", { account, payload, generatedAt });
    }
    return { ok: true };
  },
});

export const get = query({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const key = account ?? ACCOUNT_ALL;
    return await ctx.db
      .query("mv_due_returns")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
  },
});
