/**
 * MV: mv_stats_drawer (phase 7d, 2026-05-24)
 *
 * Wraps the 16-card getStatsDrawerData megaquery in a per-account cache.
 * Refresher runs the existing internal handler for each slug + stores the
 * full payload as v.any(). Dashboard subscriptions read a single indexed
 * row instead of re-running the 8-collect + 16-card compute on every
 * reservation mutation.
 *
 * Refreshed by master.refreshFast (hourly). Three rows total:
 * "all" (accountSlug=null), "dbcinema", "leo".
 *
 * Cold-start fallback: the public getStatsDrawerData query in
 * convex/dashboard.ts falls back to the internal live compute for the
 * first cron tick after deploy.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, query } from "../_generated/server";
import { api } from "../_generated/api";
import { anyApi } from "convex/server";
import { ACCOUNTS, ACCOUNT_ALL } from "./constants";

/**
 * Standalone refresher — direct invocation path (manual ops, cold-start
 * population). The hot path lives in master.refreshFast which calls this
 * action's `refreshAll` helper directly to avoid the extra action hop.
 */
export const refresh = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: true; written: number; durationMs: number }> => {
    return await refreshAll(ctx);
  },
});

/**
 * Shared compute used by both the standalone refresh action and the master
 * refreshFast orchestrator. Calls the live getStatsDrawerData per account
 * and writes the payloads in a single mutation per account.
 *
 * Pass 8a (2026-05-25) — skip-when-clean: before re-running the heavy live
 * handler (which collects 8 tables and runs ~3MB of computation per
 * account), check whether any reservation has mutated since the last MV
 * write. The live handler dominates by reading the reservations table,
 * so a quiet hour with zero poller writes can short-circuit the entire
 * refresh. Targets the ~576MB/day of cron-driven bandwidth this MV was
 * adding when it ran the full handler every hour.
 */
export async function refreshAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
): Promise<{ ok: true; written: number; durationMs: number; skipped: number }> {
  const startedAt = Date.now();
  const slugs: Array<{ key: string; arg: string | null }> = [
    { key: ACCOUNT_ALL, arg: null },
    ...ACCOUNTS.map((s) => ({ key: s, arg: s })),
  ];

  // Read the prior generatedAt for each row. Use the lowest across accounts
  // as the staleness cutoff — if ANY account has stale data, we re-run.
  const priorRows = await Promise.all(
    slugs.map(({ key }) =>
      ctx.runQuery(anyApi.mv.stats_drawer.get, { account: key }),
    ),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priorGeneratedAts: number[] = priorRows.map((r: any) => r?.generatedAt ?? 0);
  const earliestPriorGen = Math.min(...priorGeneratedAts);
  // Cold start (any row missing) → must rebuild.
  const isColdStart = priorGeneratedAts.some((g) => g === 0);
  if (!isColdStart) {
    // Skip-when-clean probe: is there ANY reservation row with
    // last_polled_at > earliestPriorGen? If not, all 3 MV rows are still
    // current relative to the source data and we can skip the rebuild.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isDirty: boolean = await ctx.runQuery(
      anyApi.mv.stats_drawer.hasReservationMutationsSince,
      { sinceMs: earliestPriorGen },
    );
    if (!isDirty) {
      return { ok: true, written: 0, skipped: slugs.length, durationMs: Date.now() - startedAt };
    }
  }

  let written = 0;
  for (const { key, arg } of slugs) {
    const payload = await ctx.runQuery(api.dashboard.getStatsDrawerData, {
      accountSlug: arg,
      _bypassMv: true,
    });
    await ctx.runMutation(anyApi.mv.stats_drawer.write, {
      account: key,
      payload,
      generatedAt: startedAt,
    });
    written += 1;
  }
  return { ok: true, written, skipped: 0, durationMs: Date.now() - startedAt };
}

export const write = internalMutation({
  args: {
    account: v.string(),
    payload: v.any(),
    generatedAt: v.number(),
  },
  handler: async (ctx, { account, payload, generatedAt }) => {
    const existing = await ctx.db
      .query("mv_stats_drawer")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { payload, generatedAt });
    } else {
      await ctx.db.insert("mv_stats_drawer", { account, payload, generatedAt });
    }
    return { ok: true };
  },
});

/**
 * Reader — returns the cached payload for an accountSlug (or "all").
 * Returns null when MV not yet populated; callers should fall back to live
 * compute in that case.
 */
export const get = query({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const key = account ?? ACCOUNT_ALL;
    const row = await ctx.db
      .query("mv_stats_drawer")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
    return row;
  },
});

/**
 * Pass 8a skip-when-clean probe. Returns true if any reservation has been
 * touched (last_polled_at OR _creationTime) since the given ms cutoff —
 * meaning the MV rows are stale and must be rebuilt. The poller bumps
 * last_polled_at on every Hygglo cycle, so this becomes false during quiet
 * hours and most cron ticks short-circuit. One indexed read instead of
 * three 8-table live computes.
 */
export const hasReservationMutationsSince = query({
  args: { sinceMs: v.number() },
  handler: async (ctx, { sinceMs }): Promise<boolean> => {
    // last_polled_at isn't indexed; use _creationTime as the cheap probe.
    // A reservation written or updated since the cutoff bumps _creationTime
    // (insert) OR last_polled_at (poller patch). We check the latter via a
    // bounded indexed scan on by_start_date (most-recently-rented first).
    // Bounded .take(1) — if any row in the recent window has a stale stamp
    // we return true. Fallback path scans the most-recent 50 reservations.
    const candidates = await ctx.db
      .query("reservations")
      .withIndex("by_start_date")
      .order("desc")
      .take(50);
    for (const r of candidates) {
      const stamp = (r as { last_polled_at?: number })?.last_polled_at ?? r._creationTime;
      if (stamp > sinceMs) return true;
    }
    return false;
  },
});
