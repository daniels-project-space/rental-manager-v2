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
import { internalAction, internalMutation, internalQuery, query } from "../_generated/server";
import { internal } from "../_generated/api";
import { anyApi } from "convex/server";
import { ACCOUNTS, ACCOUNT_ALL } from "./constants";
import {
  computeMissedAndDeniedByCategory,
  fetchMissedDeniedData,
} from "./missed_denied_compute";

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
 * The 9 (account, days) cells the dashboard exposes, in a stable order.
 * accountSlug `null` ("all") = no account filter = dbcinema + leo combined.
 */
function standardCells(): Array<{ key: string; arg: string | null; days: number }> {
  const slugs: Array<{ key: string; arg: string | null }> = [
    { key: ACCOUNT_ALL, arg: null },
    ...ACCOUNTS.map((s) => ({ key: s, arg: s })),
  ];
  const cells: Array<{ key: string; arg: string | null; days: number }> = [];
  for (const { key, arg } of slugs) {
    for (const days of STANDARD_WINDOWS) {
      cells.push({ key, arg, days });
    }
  }
  return cells;
}

/**
 * Single-pass compute (2026-06-02): does the 4 reads ONCE via
 * fetchMissedDeniedData, shares one `now` clock, then derives all 9
 * (account, days) cells in memory. Actions can't touch ctx.db, so this
 * internalQuery does the reads and refreshAll (action) just persists.
 *
 * Replaces the old 9× ctx.runQuery(getMissedAndDeniedByCategory,{_bypassMv})
 * which re-read items/pricing/obsolete(×2)/completed on every cell.
 */
export const computeAll = internalQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<Array<{ account: string; days: number; payload: any }>> => {
    const now = Date.now();
    const data = await fetchMissedDeniedData(ctx, now);
    return standardCells().map(({ key, arg, days }) => ({
      account: key,
      days,
      payload: computeMissedAndDeniedByCategory(data, {
        accountSlug: arg,
        days,
        now,
      }),
    }));
  },
});

/**
 * Shared compute used by both the standalone refresh action and the master
 * refreshSlow orchestrator. Persists every (account, days) cell.
 *
 * 3 accounts × 3 windows = 9 rows per daily refresh. Single-pass refactor:
 * the heavy reservation reads now happen ONCE inside computeAll (one
 * internalQuery hop) instead of 9× the live handler.
 */
export async function refreshAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
): Promise<{ ok: true; written: number; durationMs: number }> {
  const startedAt = Date.now();
  const cells = await ctx.runQuery(
    internal.mv.missed_denied_by_category.computeAll,
    {},
  );
  let written = 0;
  for (const c of cells) {
    await ctx.runMutation(anyApi.mv.missed_denied_by_category.write, {
      account: c.account,
      days: c.days,
      payload: c.payload,
      generatedAt: startedAt,
    });
    written += 1;
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

