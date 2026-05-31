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
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }): Promise<{ ok: true; written: number; durationMs: number; skipped?: number }> => {
    return await refreshAll(ctx, force);
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
  force: boolean = false,
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
  if (!force && !isColdStart) {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fullPayload: any = await ctx.runQuery(api.dashboard.getStatsDrawerData, {
      accountSlug: arg,
      _bypassMv: true,
    });
    // Pass 10b (2026-05-25) — split the fat rentals arrays out of the
    // payload before the main MV write. The 4 arrays (active.rentals,
    // ongoing.rentals, upcoming.rentals, confirmed.rentals) accounted for
    // ~72KB of the 78KB total. They're only read by drawer drill-downs,
    // so we cache them in mv_stats_drawer_rentals and fetch on-demand.
    const rentalsSplit = {
      active: fullPayload?.active?.rentals ?? [],
      ongoing: fullPayload?.ongoing?.rentals ?? [],
      upcoming: fullPayload?.upcoming?.rentals ?? [],
      confirmed: fullPayload?.confirmed?.rentals ?? [],
    };
    const trimmed = {
      ...fullPayload,
      active: { ...(fullPayload?.active ?? {}), rentals: undefined },
      ongoing: { ...(fullPayload?.ongoing ?? {}), rentals: undefined },
      upcoming: { ...(fullPayload?.upcoming ?? {}), rentals: undefined },
      confirmed: { ...(fullPayload?.confirmed ?? {}), rentals: undefined },
    };
    // Drop the undefined `rentals` keys cleanly so they don't appear in
    // the stored JSON.
    for (const card of ["active", "ongoing", "upcoming", "confirmed"] as const) {
      if (trimmed[card]) delete trimmed[card].rentals;
    }
    await ctx.runMutation(anyApi.mv.stats_drawer.write, {
      account: key,
      payload: trimmed,
      generatedAt: startedAt,
    });
    await ctx.runMutation(anyApi.mv.stats_drawer.writeRentals, {
      account: key,
      rentals: rentalsSplit,
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

/** Pass 10b — drawer drill-down rentals lists split into a separate MV
 *  row so always-subscribed dashboard widgets only read the trimmed
 *  headline payload (~6KB vs 78KB). */
export const writeRentals = internalMutation({
  args: {
    account: v.string(),
    rentals: v.any(),
    generatedAt: v.number(),
  },
  handler: async (ctx, { account, rentals, generatedAt }) => {
    const existing = await ctx.db
      .query("mv_stats_drawer_rentals")
      .withIndex("by_account", (q) => q.eq("account", account))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { rentals, generatedAt });
    } else {
      await ctx.db.insert("mv_stats_drawer_rentals", { account, rentals, generatedAt });
    }
    return { ok: true };
  },
});

/** Drawer drill-down reader — frontend subscribes to this ONLY when a
 *  stat-card drawer is expanded. Returns the 4 rentals arrays
 *  (active / ongoing / upcoming / confirmed) for the requested account. */
export const getRentals = query({
  args: { account: v.optional(v.string()) },
  handler: async (ctx, { account }) => {
    const key = account ?? ACCOUNT_ALL;
    const row = await ctx.db
      .query("mv_stats_drawer_rentals")
      .withIndex("by_account", (q) => q.eq("account", key))
      .first();
    return row;
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
    // Newest poller patch. last_polled_at is bumped on ANY touched reservation
    // (insert or status change) regardless of its start_date, so the max of it
    // is the true "anything changed?" signal. The previous probe scanned the
    // top-50 by future start_date and therefore MISSED status changes on
    // past/ongoing rentals — leaving the MV (and the dashboard tile) stale for
    // hours. One indexed read of the most-recent stamp.
    const newestPolled = await ctx.db
      .query("reservations")
      .withIndex("by_last_polled_at")
      .order("desc")
      .first();
    const polledStamp = (newestPolled as { last_polled_at?: number } | null)?.last_polled_at;
    if (typeof polledStamp === "number" && polledStamp > sinceMs) return true;
    // Belt-and-braces for rows inserted but not yet poller-stamped.
    const newestCreated = await ctx.db
      .query("reservations")
      .withIndex("by_creation_time")
      .order("desc")
      .first();
    if (newestCreated && newestCreated._creationTime > sinceMs) return true;
    return false;
  },
});
