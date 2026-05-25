/**
 * MV: mv_missed_and_denied_by_category (pass 9d, 2026-05-25)
 *
 * Wraps the getMissedAndDeniedByCategory handler in a per-(account, days)
 * cache. Per Convex billing, the live handler was 56.99 GB/day of
 * reservation-bandwidth — the single biggest cost source after the audit.
 *
 * Refreshed by master.refreshSlow (daily) for the 3 standard windows that
 * the dashboard toggle exposes (30 / 90 / 365 days). One row per
 * (account, days) — 9 rows total at steady state.
 *
 * Cold-start fallback: the public getMissedAndDeniedByCategory query in
 * convex/revenue.ts falls back to the live handler for the first cron
 * tick after deploy and for non-standard `days` values.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, query } from "../_generated/server";
import { api } from "../_generated/api";
import { anyApi } from "convex/server";
import { ACCOUNTS, ACCOUNT_ALL } from "./constants";

export const STANDARD_WINDOWS = [30, 90, 365] as const;

/**
 * Standalone refresher — direct invocation path (manual ops, cold-start
 * population). The hot path lives in master.refreshSlow which calls
 * refreshAll directly to share the action hop.
 */
export const refresh = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: true; written: number; durationMs: number }> => {
    return await refreshAll(ctx);
  },
});

/**
 * Shared compute used by both the standalone refresh action and the master
 * refreshSlow orchestrator. Calls the live getMissedAndDeniedByCategory
 * handler for every (account, days) combo and stores the payload.
 *
 * 3 accounts × 3 windows = 9 calls per daily refresh. Each call still does
 * heavy live compute (~40MB of reservation reads) but it happens ONCE per
 * day instead of on every dashboard load.
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
    for (const days of STANDARD_WINDOWS) {
      const payload = await ctx.runQuery(
        api.revenue.getMissedAndDeniedByCategory,
        { accountSlug: arg, days, _bypassMv: true },
      );
      await ctx.runMutation(anyApi.mv.missed_denied_by_category.write, {
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
  args: {
    account: v.string(),
    days: v.number(),
    payload: v.any(),
    generatedAt: v.number(),
  },
  handler: async (ctx, { account, days, payload, generatedAt }) => {
    const existing = await ctx.db
      .query("mv_missed_and_denied_by_category")
      .withIndex("by_account_days", (q) =>
        q.eq("account", account).eq("days", days),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { payload, generatedAt });
    } else {
      await ctx.db.insert("mv_missed_and_denied_by_category", {
        account,
        days,
        payload,
        generatedAt,
      });
    }
    return { ok: true };
  },
});

/**
 * Reader — returns the cached payload for (accountSlug, days). Returns
 * null when MV not yet populated; callers should fall back to live
 * compute in that case (handled in revenue.ts:getMissedAndDeniedByCategory).
 */
export const get = query({
  args: {
    account: v.optional(v.string()),
    days: v.number(),
  },
  handler: async (ctx, { account, days }) => {
    const key = account ?? ACCOUNT_ALL;
    const row = await ctx.db
      .query("mv_missed_and_denied_by_category")
      .withIndex("by_account_days", (q) =>
        q.eq("account", key).eq("days", days),
      )
      .first();
    return row;
  },
});
