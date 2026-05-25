/**
 * MV: mv_rental_volume_kind_breakdown (pass 10a, 2026-05-25)
 *
 * Wraps the getRentalVolumeKindBreakdown handler in a per-(account, days,
 * kind) cache. Per Convex billing, this query was 24.27 GB/day + 62K
 * function calls — second-biggest cost source after getMissedAndDeniedByCategory.
 *
 * Each live call does a 365d reservations.collect + items.collect +
 * pricing_catalog.collect to produce a ~1KB per-kind breakdown. Storing
 * the ~1KB result + reading it for every dashboard click eliminates the
 * server-side row reads entirely.
 *
 * Refreshed by master.refreshSlow (daily). ~8 kinds × 3 windows × 3
 * accounts = 72 rows at steady state.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "../_generated/server";
import { api } from "../_generated/api";
import { anyApi } from "convex/server";
import { ACCOUNTS, ACCOUNT_ALL } from "./constants";

export const STANDARD_WINDOWS = [30, 90, 365] as const;

/** Distinct kinds currently in the items table. Used by the refresher to
 *  enumerate the (account, days, kind) tuples to pre-compute. */
export const listDistinctKinds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const items = await ctx.db.query("items").collect();
    const kinds = new Set<string>();
    for (const it of items) {
      if (it.kind) kinds.add(it.kind);
    }
    return Array.from(kinds);
  },
});

export const refresh = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: true; written: number; durationMs: number }> => {
    return await refreshAll(ctx);
  },
});

/**
 * Shared compute used by both the standalone refresh action and the master
 * refreshSlow orchestrator. Calls the live getRentalVolumeKindBreakdown
 * handler for every (account, days, kind) combo.
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
  const kinds: string[] = await ctx.runQuery(anyApi.mv.rental_volume_kind_breakdown.listDistinctKinds, {});
  let written = 0;
  for (const { key, arg } of slugs) {
    for (const days of STANDARD_WINDOWS) {
      for (const kind of kinds) {
        const payload = await ctx.runQuery(
          api.dashboard.getRentalVolumeKindBreakdown,
          { accountSlug: arg, days, kind, _bypassMv: true },
        );
        await ctx.runMutation(anyApi.mv.rental_volume_kind_breakdown.write, {
          account: key,
          days,
          kind,
          payload,
          generatedAt: startedAt,
        });
        written += 1;
      }
    }
  }
  return { ok: true, written, durationMs: Date.now() - startedAt };
}

export const write = internalMutation({
  args: {
    account: v.string(),
    days: v.number(),
    kind: v.string(),
    payload: v.any(),
    generatedAt: v.number(),
  },
  handler: async (ctx, { account, days, kind, payload, generatedAt }) => {
    const existing = await ctx.db
      .query("mv_rental_volume_kind_breakdown")
      .withIndex("by_account_days_kind", (q) =>
        q.eq("account", account).eq("days", days).eq("kind", kind),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { payload, generatedAt });
    } else {
      await ctx.db.insert("mv_rental_volume_kind_breakdown", {
        account,
        days,
        kind,
        payload,
        generatedAt,
      });
    }
    return { ok: true };
  },
});

export const get = query({
  args: {
    account: v.optional(v.string()),
    days: v.number(),
    kind: v.string(),
  },
  handler: async (ctx, { account, days, kind }) => {
    const key = account ?? ACCOUNT_ALL;
    const row = await ctx.db
      .query("mv_rental_volume_kind_breakdown")
      .withIndex("by_account_days_kind", (q) =>
        q.eq("account", key).eq("days", days).eq("kind", kind),
      )
      .first();
    return row;
  },
});
