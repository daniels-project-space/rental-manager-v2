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
  // 2026-07-13 cost audit: ONE live "all" compute, sliced per account (was 5
  // full live runs — ~5× the confirmed-collect + renter lookups per refresh).
  // Safe: the live handler's accountSlug arg is used ONLY for the initial row
  // filter (reservations.ts:111) and every row derivation keys off the row's
  // own account; both grouping fns (groupLogicalRentals / renterPeriodGroupIds,
  // predicates.ts) include account_slug in their bucket keys so groups never
  // span accounts — compute(all).filter(accountSlug===slug) ≡ compute(slug),
  // and filtering preserves the comparator order on the subset.
  const allPayload: Array<Record<string, unknown> & { accountSlug?: string }> =
    await ctx.runQuery(api.reservations.getDueReturns, {
      accountSlug: null,
      _bypassMv: true,
    });
  let written = 0;
  for (const { key, arg } of slugs) {
    const payload =
      arg === null
        ? allPayload
        : allPayload.filter((row) => row.accountSlug === arg);
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
