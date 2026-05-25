/**
 * MV: mv_rental_volume_by_category (pass 11d, 2026-05-25)
 *
 * Wraps dashboard.getRentalVolumeByCategory. Per Convex billing:
 * ~20GB/month. Partner to mv_rental_volume_kind_breakdown (10a).
 *
 * Refresher: daily for 3 standard windows (30/90/365).
 */
import { v } from "convex/values";
import { internalAction, internalMutation, query } from "../_generated/server";
import { api } from "../_generated/api";
import { anyApi } from "convex/server";
import { ACCOUNTS, ACCOUNT_ALL } from "./constants";

export const STANDARD_WINDOWS = [30, 90, 365] as const;

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
    for (const days of STANDARD_WINDOWS) {
      const payload = await ctx.runQuery(api.dashboard.getRentalVolumeByCategory, {
        accountSlug: arg,
        days,
        _bypassMv: true,
      });
      await ctx.runMutation(anyApi.mv.rental_volume_by_category.write, {
        account: key,
        days,
        payload,
        generatedAt: startedAt,
      });
      written += 1;
    }
  }
  return { ok: true, written, durationMs: Date.now() - startedAt };
}

export const write = internalMutation({
  args: { account: v.string(), days: v.number(), payload: v.any(), generatedAt: v.number() },
  handler: async (ctx, { account, days, payload, generatedAt }) => {
    const existing = await ctx.db
      .query("mv_rental_volume_by_category")
      .withIndex("by_account_days", (q) => q.eq("account", account).eq("days", days))
      .first();
    if (existing) await ctx.db.patch(existing._id, { payload, generatedAt });
    else await ctx.db.insert("mv_rental_volume_by_category", { account, days, payload, generatedAt });
    return { ok: true };
  },
});

export const get = query({
  args: { account: v.optional(v.string()), days: v.number() },
  handler: async (ctx, { account, days }) => {
    const key = account ?? ACCOUNT_ALL;
    return await ctx.db
      .query("mv_rental_volume_by_category")
      .withIndex("by_account_days", (q) => q.eq("account", key).eq("days", days))
      .first();
  },
});
