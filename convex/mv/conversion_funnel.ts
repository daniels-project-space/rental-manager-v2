/**
 * MV: mv_conversion_funnel (pass 11c, 2026-05-25)
 *
 * Wraps reservations.getConversionFunnel. Per Convex billing: ~100GB/month.
 * Reads full reservations + conversations + denial_records for ratio calc.
 *
 * Refresher: daily for 3 standard windows (30/90/365 days).
 */
import { v } from "convex/values";
import { internalAction, internalMutation, query } from "../_generated/server";
import { anyApi } from "convex/server";
import { ACCOUNTS, ACCOUNT_ALL } from "./constants";

// Include 7 — the ConversationFunnel widget offers 7/30/90; without a cached
// 7-day row that option fell through to a live compute on every render.
export const STANDARD_WINDOWS = [7, 30, 90, 365] as const;

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
  // 2026-09-02: this used to call getConversionFunnel once per (account,
  // window) — 5 x 4 = 20 COMPLETE scans of hygglo_messages + reservations per
  // refresh. The matrix query builds the per-thread first-contact index once
  // and slices it in memory, so a refresh is now a single scan.
  const cells: Array<{ accountSlug: string | null; days: number; payload: unknown }> =
    await ctx.runQuery(anyApi.reservations.computeConversionFunnelMatrix, {
      accounts: slugs.map((s) => s.arg),
      windows: [...STANDARD_WINDOWS],
    });
  const keyForArg = new Map<string | null, string>(slugs.map((s) => [s.arg, s.key]));
  let written = 0;
  for (const cell of cells) {
    await ctx.runMutation(anyApi.mv.conversion_funnel.write, {
      account: keyForArg.get(cell.accountSlug) ?? ACCOUNT_ALL,
      days: cell.days,
      payload: cell.payload,
      generatedAt: startedAt,
    });
    written += 1;
  }
  return { ok: true, written, durationMs: Date.now() - startedAt };
}

export const write = internalMutation({
  args: { account: v.string(), days: v.number(), payload: v.any(), generatedAt: v.number() },
  handler: async (ctx, { account, days, payload, generatedAt }) => {
    const existing = await ctx.db
      .query("mv_conversion_funnel")
      .withIndex("by_account_days", (q) => q.eq("account", account).eq("days", days))
      .first();
    if (existing) await ctx.db.patch(existing._id, { payload, generatedAt });
    else await ctx.db.insert("mv_conversion_funnel", { account, days, payload, generatedAt });
    return { ok: true };
  },
});

export const get = query({
  args: { account: v.optional(v.string()), days: v.number() },
  handler: async (ctx, { account, days }) => {
    const key = account ?? ACCOUNT_ALL;
    return await ctx.db
      .query("mv_conversion_funnel")
      .withIndex("by_account_days", (q) => q.eq("account", key).eq("days", days))
      .first();
  },
});
