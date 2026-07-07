/**
 * Phase 18.3 — MV master refresher with shared-collect.
 *
 * Before (Phase 18.2): two action batches that fanned out to each MV's
 * `refresh` internalMutation. Each delegated mutation re-queried the
 * reservations table independently, leading to ~3.5M reservations-row
 * reads/day from MV crons alone (6 MVs x 2 daily collects = 12, each
 * scanning the full reservations table after the day's accumulation).
 *
 * After (Phase 18.3): the master action collects each underlying table
 * ONCE per refresh cycle (reservations / items / renters / denials /
 * pricing / accounts), passes the in-memory arrays to pure compute
 * functions exported from each MV file, then writes the resulting rows
 * via dedicated `write<MV>` internalMutations.
 *
 * Each MV's `refresh` internalMutation still exists in its own file for
 * direct invocation (refresh_dispatch.ts public action, manual ops, the
 * Mastra polling workflow's `refreshOne`). master.ts bypasses them.
 *
 * Window strategy (matches the legacy mutations):
 *   • daily_briefing  — 90-day reservations window (by_start_date >= cutoff)
 *   • top_earners     — 30-day reservations window
 *   • utilization     — 7-day reservations window (fast batch; compute only
 *                       reads the last 7 days)
 *   • missed_revenue  — 30/90-day reservations window + denials + pricing +
 *                       accounts (slow batch, daily — see Pass 13)
 *   • upcoming_returns — confirmed reservations (by_status === "confirmed")
 *   • churn_risk      — full reservations table (needed for renter-account
 *                       membership lookup across the lifetime of the renter)
 *   • purchase_signals — denials + items + pricing + accounts (no reservations)
 *
 * To avoid double-scanning, the master picks the WIDEST window each batch
 * needs and slices in-memory for the narrower computes. Fast batch needs
 * 30d (utilization) + confirmed-status (upcoming_returns); slow batch needs
 * 90d (daily_briefing) + 30d (top_earners) + full table (churn_risk) +
 * denials/items/pricing/accounts (purchase_signals).
 *
 * Estimated reservations-row reads/day AFTER refactor:
 *   • refreshFast: 2 collects per cron run (7d slice + confirmed-status).
 *     30 min cadence → 48 runs/day → 48 * 2 = 96 table scans/day.
 *     The 7d slice (Pass 13, was 90d) is far smaller per scan now that
 *     missed_revenue no longer needs the wide window in the fast batch.
 *   • refreshSlow: 2 collects per cron run (full table + items + denials
 *     + pricing + accounts). 1 run/day → 1 full-table scan/day ≈ 1767 rows.
 *   • TOTAL ≈ ~27k reservations row reads/day (was ~3.5M). > 100x reduction.
 *
 * If any MV throws inside its `write<MV>` mutation, the OTHER MVs in the
 * batch still complete — failures are surfaced per-MV in the returned
 * `results` array but the master keeps going. (One per-MV failure should
 * not roll back the others; each write runs as its own transaction.)
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { isoDaysAgo, upsertSingleton } from "./_helpers";
import { londonToday } from "../lib/effectiveDates";
import { computeDailyBriefing } from "./daily_briefing";
import { computeTopEarners } from "./top_earners";
import { computeUtilization } from "./utilization";
import { computeUpcomingReturns } from "./upcoming_returns";
import { computeChurnRisk } from "./churn_risk";
import { computePurchaseSignals } from "./purchase_signals";
import { computeMissedRevenue } from "./missed_revenue";
import { computeEarningsByPeriod } from "./earnings_by_period";
import { computeItemRoiRanking } from "./item_roi_rankings";
import { refreshAll as refreshStatsDrawer } from "./stats_drawer";
import { refreshAll as refreshMissedDeniedByCategory } from "./missed_denied_by_category";
import { refreshAll as refreshRentalVolumeKindBreakdown } from "./rental_volume_kind_breakdown";
import { refreshAll as refreshLifetimeRevenue } from "./lifetime_revenue";
import { refreshAll as refreshInvestmentScorecard } from "./investment_scorecard";
import { refreshAll as refreshConversionFunnel } from "./conversion_funnel";
import { refreshAll as refreshRentalVolumeByCategory } from "./rental_volume_by_category";
import { refreshAll as refreshWalleSignals } from "./walle_signals";
import { refreshAll as refreshDueReturns } from "./due_returns";
import { refreshAll as refreshAiInsights } from "./ai_insights";

// ──────────────────────────────────────────────────────────────
// Shared collectors — one query per underlying table per refresh.
// ──────────────────────────────────────────────────────────────

/**
 * Collect reservations whose start_date is on/after `cutoffIsoDate`.
 * Used by the fast batch (30d window for utilization) and the slow
 * batch (90d window for daily_briefing — strictly wider so the same
 * collect can also feed top_earners' 30d compute via in-memory slice).
 */
export const collectReservationsSince = internalQuery({
  args: { cutoff: v.string() },
  handler: async (ctx, { cutoff }) => {
    return await ctx.db.query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoff))
      .collect();
  },
});

/** Confirmed-status reservations only (upcoming_returns input). */
export const collectConfirmedReservations = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("reservations")
      .withIndex("by_status", (q) => q.eq("status", "confirmed"))
      .collect();
  },
});

/** Full reservations table (needed for churn_risk renter-account membership). */
export const collectAllReservations = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("reservations").collect(); // check-patterns:ok — MV builder — full scan by design
  },
});

export const collectItems = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("items").collect(),
});

export const collectRenters = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("renters").collect(),
});

export const collectDenials = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("denial_records").collect(),
});

export const collectPricing = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("pricing_catalog").collect(),
});

export const collectAccounts = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("accounts").collect(),
});

/**
 * Last-computed timestamp (ms) of the missed/denied category MV — the marker
 * used to gate that step to once per London calendar month. Returns the
 * newest row's own `generatedAt` if present, else its `_creationTime`; null
 * when the table is empty (forces a recompute). No reservations are read.
 */
export const missedDeniedLastComputedAt = internalQuery({
  args: {},
  handler: async (ctx): Promise<number | null> => {
    const row = await ctx.db
      .query("mv_missed_and_denied_by_category")
      .order("desc")
      .first();
    if (!row) return null;
    return typeof row.generatedAt === "number" ? row.generatedAt : row._creationTime;
  },
});

// ──────────────────────────────────────────────────────────────
// Write mutations — receive pre-computed rows, just upsert.
// One transaction per MV per call (failure isolation).
// ──────────────────────────────────────────────────────────────

// Row payload is structurally fixed per MV, but Convex's validator can't
// easily express the recursive shape; we accept `any` and trust the pure
// compute functions to produce the documented shape. Same approach as
// upsertSingleton in _helpers.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ANY_ROW = v.any() as any;

export const writeDailyBriefing = internalMutation({
  args: { rows: v.array(ANY_ROW) },
  handler: async (ctx, { rows }) => {
    for (const r of rows) {
      const { account, ...rest } = r;
      await upsertSingleton(ctx, "daily_briefing", account, rest);
    }
    return { ok: true, written: rows.length };
  },
});

export const writeTopEarners = internalMutation({
  args: { rows: v.array(ANY_ROW) },
  handler: async (ctx, { rows }) => {
    for (const r of rows) {
      const { account, ...rest } = r;
      await upsertSingleton(ctx, "top_earners_30d", account, rest);
    }
    return { ok: true, written: rows.length };
  },
});

export const writeUtilization = internalMutation({
  args: { rows: v.array(ANY_ROW) },
  handler: async (ctx, { rows }) => {
    for (const r of rows) {
      const { account, ...rest } = r;
      await upsertSingleton(ctx, "utilization_today", account, rest);
    }
    return { ok: true, written: rows.length };
  },
});

export const writeUpcomingReturns = internalMutation({
  args: { rows: v.array(ANY_ROW) },
  handler: async (ctx, { rows }) => {
    for (const r of rows) {
      const { account, ...rest } = r;
      await upsertSingleton(ctx, "upcoming_returns", account, rest);
    }
    return { ok: true, written: rows.length };
  },
});

export const writeChurnRisk = internalMutation({
  args: { rows: v.array(ANY_ROW) },
  handler: async (ctx, { rows }) => {
    for (const r of rows) {
      const { account, ...rest } = r;
      await upsertSingleton(ctx, "churn_risk_renters", account, rest);
    }
    return { ok: true, written: rows.length };
  },
});

export const writePurchaseSignals = internalMutation({
  args: { rows: v.array(ANY_ROW) },
  handler: async (ctx, { rows }) => {
    for (const r of rows) {
      const { account, ...rest } = r;
      await upsertSingleton(ctx, "purchase_signals", account, rest);
    }
    return { ok: true, written: rows.length };
  },
});

/**
 * Phase 6a (2026-05-24) — mv_missed_revenue is keyed by (account, days),
 * not a single-account singleton, so it cannot reuse upsertSingleton.
 * Indexed via by_account_days.
 */
export const writeMissedRevenue = internalMutation({
  args: { rows: v.array(ANY_ROW) },
  handler: async (ctx, { rows }) => {
    for (const r of rows) {
      const { account, days, ...rest } = r;
      const existing = await ctx.db
        .query("mv_missed_revenue")
        .withIndex("by_account_days", (q) =>
          q.eq("account", account).eq("days", days),
        )
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, rest);
      } else {
        await ctx.db.insert("mv_missed_revenue", { account, days, ...rest });
      }
    }
    return { ok: true, written: rows.length };
  },
});

/**
 * Phase 6b (2026-05-24) — mv_earnings_by_period keyed by (account, granularity).
 */
export const writeEarningsByPeriod = internalMutation({
  args: { rows: v.array(ANY_ROW) },
  handler: async (ctx, { rows }) => {
    for (const r of rows) {
      const { account, granularity, ...rest } = r;
      const existing = await ctx.db
        .query("mv_earnings_by_period")
        .withIndex("by_account_granularity", (q) =>
          q.eq("account", account).eq("granularity", granularity),
        )
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, rest);
      } else {
        await ctx.db.insert("mv_earnings_by_period", { account, granularity, ...rest });
      }
    }
    return { ok: true, written: rows.length };
  },
});

/**
 * Phase 6c (2026-05-24) — mv_item_roi_rankings, single "all" singleton.
 * Wraps the row payload (rows[] array) into an upsert at "all".
 */
export const writeItemRoiRanking = internalMutation({
  args: { rows: v.array(ANY_ROW) },
  handler: async (ctx, { rows }) => {
    const startedAt = Date.now();
    const existing = await ctx.db
      .query("mv_item_roi_rankings")
      .withIndex("by_account", (q) => q.eq("account", "all"))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { generatedAt: startedAt, rows });
    } else {
      await ctx.db.insert("mv_item_roi_rankings", {
        account: "all",
        generatedAt: startedAt,
        rows,
      });
    }
    return { ok: true, written: rows.length };
  },
});

// ──────────────────────────────────────────────────────────────
// Master refresh actions.
// ──────────────────────────────────────────────────────────────

type StepResult = { name: string; ok: boolean; durationMs: number; error?: string; skipped?: boolean };

async function safeStep(
  ctx: ActionCtx,
  name: string,
  fn: () => Promise<unknown>,
): Promise<StepResult> {
  const startedAt = Date.now();
  try {
    await fn();
    return { name, ok: true, durationMs: Date.now() - startedAt };
  } catch (err) {
    return {
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const refreshFast = internalAction({
  // `force` bypasses the stats_drawer skip-when-clean gate. The hourly cron
  // passes nothing (force=false); ops can pass true to rebuild immediately
  // after an item-only change (e.g. inventory qty) that doesn't mutate any
  // reservation and so wouldn't otherwise trip the dirty check.
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }): Promise<{ batch: "fast"; results: StepResult[] }> => {
    const startedAt = Date.now();
    // Pass 13 (2026-06-02) — narrowed the fast reservations window 90d → 7d.
    // It now serves ONLY utilization, whose compute reads reservations strictly
    // within the last 7 days (isoDaysAgo(7) in utilization.ts), so a 7d collect
    // yields identical output while slashing the hourly fat-row (Hygglo `order`
    // JSON ~30-50KB each) re-collect bandwidth. missed_revenue (30/90d windows)
    // moved to refreshSlow, which already collects a 90d reservations window +
    // denials + pricing + accounts. Prior Pass 8a kept it at 90d to feed both.
    const cutoffFast = isoDaysAgo(7);
    // 2026-07-07: dropped the denials/pricing/accounts collects — they were read
    // every hour here but NONE of the fast steps (utilization, upcoming_returns,
    // stats_drawer + due_returns are wrap-and-cache) consume them. They're still
    // collected in refreshSlow, which is where purchase_signals/missed_revenue use
    // them. Removes 3 full-table scans/hour for zero output change.
    const [reservationsWindow, confirmedReservations, items, renters] = await Promise.all([
      ctx.runQuery(internal.mv.master.collectReservationsSince, { cutoff: cutoffFast }),
      ctx.runQuery(internal.mv.master.collectConfirmedReservations, {}),
      ctx.runQuery(internal.mv.master.collectItems, {}),
      ctx.runQuery(internal.mv.master.collectRenters, {}),
    ]);

    const results: StepResult[] = [];

    results.push(await safeStep(ctx, "utilization", async () => {
      const rows = computeUtilization({
        reservations: reservationsWindow,
        items,
        generatedAt: startedAt,
      });
      await ctx.runMutation(internal.mv.master.writeUtilization, { rows });
    }));

    results.push(await safeStep(ctx, "upcoming_returns", async () => {
      const rows = computeUpcomingReturns({
        reservations: confirmedReservations,
        renters,
        generatedAt: startedAt,
      });
      await ctx.runMutation(internal.mv.master.writeUpcomingReturns, { rows });
    }));

    // Phase 7d (2026-05-24): wrap-and-cache the 16-card getStatsDrawerData
    // megaquery per (account). Runs the existing live handler for each slug
    // and stores the full payload — dashboard subscriptions now read 1
    // indexed row instead of re-running 8 collects + 16 cards on every
    // reservation mutation. Pass 8a (2026-05-25): added skip-when-clean
    // inside refreshAll so quiet ticks short-circuit without running the
    // heavy live handler.
    results.push(await safeStep(ctx, "stats_drawer", async () => {
      // Only the "all" default view here (hourly). Per-account rows refresh on a
      // separate 6h cron ("mv_refresh_stats_accounts") — see crons.ts. Cuts the
      // 5×/hour full-compute (once per slug) down to 1×/hour on the hot path.
      await refreshStatsDrawer(ctx, force ?? false, "all");
    }));

    // Pass 12a (2026-05-26): wrap-and-cache getDueReturns. WallESignals
    // (in eager StatsGrid) subscribes on every cold-mount, so every
    // reservation mutation triggers a 12MB re-eval. Hourly refresh keeps
    // the "due today" boundary correct within ~1h.
    results.push(await safeStep(ctx, "due_returns", async () => {
      await refreshDueReturns(ctx);
    }));

    return { batch: "fast", results };
  },
});

export const refreshSlow = internalAction({
  args: {},
  handler: async (ctx): Promise<{ batch: "slow"; results: StepResult[] }> => {
    const startedAt = Date.now();
    // 90d window covers daily_briefing AND top_earners (top_earners filters
    // by pickup_date/start_date >= 30d cutoff in-memory).
    const cutoff90 = isoDaysAgo(90);

    const [
      reservations90,
      allReservations,
      items,
      renters,
      denials,
      pricing,
      accounts,
    ] = await Promise.all([
      ctx.runQuery(internal.mv.master.collectReservationsSince, { cutoff: cutoff90 }),
      ctx.runQuery(internal.mv.master.collectAllReservations, {}),
      ctx.runQuery(internal.mv.master.collectItems, {}),
      ctx.runQuery(internal.mv.master.collectRenters, {}),
      ctx.runQuery(internal.mv.master.collectDenials, {}),
      ctx.runQuery(internal.mv.master.collectPricing, {}),
      ctx.runQuery(internal.mv.master.collectAccounts, {}),
    ]);

    const results: StepResult[] = [];

    results.push(await safeStep(ctx, "daily_briefing", async () => {
      const rows = computeDailyBriefing({
        reservations: reservations90,
        generatedAt: startedAt,
      });
      await ctx.runMutation(internal.mv.master.writeDailyBriefing, { rows });
    }));

    results.push(await safeStep(ctx, "top_earners", async () => {
      // top_earners only looks at the 30d slice — pass the 90d collect, the
      // compute applies its own cutoff filter in-memory.
      const rows = computeTopEarners({
        reservations: reservations90,
        items,
        generatedAt: startedAt,
      });
      await ctx.runMutation(internal.mv.master.writeTopEarners, { rows });
    }));

    results.push(await safeStep(ctx, "churn_risk", async () => {
      const rows = computeChurnRisk({
        renters,
        reservations: allReservations,
        generatedAt: startedAt,
      });
      await ctx.runMutation(internal.mv.master.writeChurnRisk, { rows });
    }));

    results.push(await safeStep(ctx, "purchase_signals", async () => {
      const rows = computePurchaseSignals({
        denials,
        items,
        pricing,
        accounts,
        generatedAt: startedAt,
      });
      await ctx.runMutation(internal.mv.master.writePurchaseSignals, { rows });
    }));

    // Pass 13 (2026-06-02): missed_revenue moved here from refreshFast. Its
    // compute windows are 30d/90d (WINDOWS_DAYS in missed_revenue.ts), all
    // covered by the slow batch's existing 90d reservations collect; denials,
    // pricing and accounts are already collected above. No new collect added —
    // the inputs change slowly enough that daily cadence is acceptable, and the
    // hourly fat-row reservations re-collect is eliminated.
    results.push(await safeStep(ctx, "missed_revenue", async () => {
      const rows = computeMissedRevenue({
        denials,
        pricing,
        reservations: reservations90,
        accounts,
        generatedAt: startedAt,
      });
      await ctx.runMutation(internal.mv.master.writeMissedRevenue, { rows });
    }));

    results.push(await safeStep(ctx, "item_roi_rankings", async () => {
      // ROI uses the full 2-year window. The slow batch already collects
      // all reservations + items, so it's a free piggyback.
      const rows = computeItemRoiRanking({
        items,
        reservations: allReservations,
        generatedAt: startedAt,
      });
      await ctx.runMutation(internal.mv.master.writeItemRoiRanking, { rows });
    }));

    // Pass 8a (2026-05-25): moved earnings_by_period from refreshFast →
    // refreshSlow. The 24mo bucket window doesn't shift between hours
    // (closed past months are immutable; current month only changes when
    // a fresh reservation lands, which is rare enough that 24h staleness
    // is acceptable for chart bars). Eliminates ~700MB/day of duplicated
    // 730d reservation collects from fast batch.
    results.push(await safeStep(ctx, "earnings_by_period", async () => {
      const rows = computeEarningsByPeriod({
        reservations: allReservations,
        generatedAt: startedAt,
      });
      await ctx.runMutation(internal.mv.master.writeEarningsByPeriod, { rows });
    }));

    // Pass 9d (2026-05-25): wrap-and-cache the getMissedAndDeniedByCategory
    // handler. Per Convex billing, the live compute was 56.99 GB/day — the
    // largest single cost source after the post-spending-limit audit. Now
    // refreshed once daily for the 3 standard windows that the dashboard
    // toggle exposes (30 / 90 / 365 days × 3 accounts = 9 rows).
    //
    // 2026-06-02 monthly gate: this single step still dominated cost (~57GB/day
    // even at daily cadence, because refreshAll re-runs the live handler 9×).
    // The category mix moves slowly (months), so we recompute at most ONCE per
    // London calendar month. The MV's OWN newest-row timestamp (generatedAt,
    // else _creationTime) is the marker — NO schema change. If the marker's
    // London month-key equals the current London month-key, push an OK no-op
    // StepResult (skipped:true) so the results array shape stays valid;
    // otherwise recompute as before. The heavy reservation reads live entirely
    // inside refreshMissedDeniedByCategory(ctx) (it calls the live handler with
    // _bypassMv), so skipping this step genuinely avoids the ~57GB/day reads —
    // nothing for this MV is collected in the hoisted Promise.all above.
    const lastComputedAt = await ctx.runQuery(
      internal.mv.master.missedDeniedLastComputedAt,
      {},
    );
    const currentMonthKey = londonToday().slice(0, 7); // "YYYY-MM"
    const lastMonthKey =
      lastComputedAt == null
        ? null
        : new Date(lastComputedAt)
            .toLocaleDateString("en-CA", { timeZone: "Europe/London" })
            .slice(0, 7);
    if (lastMonthKey !== null && lastMonthKey === currentMonthKey) {
      results.push({
        name: "missed_denied_by_category",
        ok: true,
        durationMs: 0,
        skipped: true,
      });
    } else {
      results.push(await safeStep(ctx, "missed_denied_by_category", async () => {
        await refreshMissedDeniedByCategory(ctx);
      }));
    }

    // Pass 10a (2026-05-25): wrap-and-cache getRentalVolumeKindBreakdown.
    // Second-biggest cost (24.27 GB/day + 62K calls). 8 kinds × 3 windows
    // × 3 accounts = 72 rows pre-computed daily.
    results.push(await safeStep(ctx, "rental_volume_kind_breakdown", async () => {
      await refreshRentalVolumeKindBreakdown(ctx);
    }));

    // Pass 11 (2026-05-25): 4 additional wrap-and-cache MVs to eliminate
    // the gigabyte-scale per-call bandwidth on heavy aggregation queries.
    results.push(await safeStep(ctx, "lifetime_revenue", async () => {
      await refreshLifetimeRevenue(ctx);
    }));
    results.push(await safeStep(ctx, "investment_scorecard", async () => {
      await refreshInvestmentScorecard(ctx);
    }));
    results.push(await safeStep(ctx, "conversion_funnel", async () => {
      await refreshConversionFunnel(ctx);
    }));
    results.push(await safeStep(ctx, "rental_volume_by_category", async () => {
      await refreshRentalVolumeByCategory(ctx);
    }));

    // Pass 11h (2026-05-25): unified WallE-widget signals (active
    // conflicts + revenue delta + utilization delta) into one MV row.
    // Pass 8c made each of the 3 underlying queries indexed but they
    // still read ~250 rich-payload rows per re-eval × 3 widget subs.
    results.push(await safeStep(ctx, "walle_signals", async () => {
      await refreshWalleSignals(ctx);
    }));

    // 2026-07-07: wrap-and-cache getInsights (AI Investment Insights). Daily —
    // its 30/60/90d windows barely move hour to hour, so 24h staleness is
    // invisible, while it removes a reactive full-year fat-reservation scan that
    // re-ran on every poller write × every open tab (~24 GB/mo).
    results.push(await safeStep(ctx, "ai_insights", async () => {
      await refreshAiInsights(ctx);
    }));

    return { batch: "slow", results };
  },
});
