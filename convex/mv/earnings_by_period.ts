/**
 * MV: mv_earnings_by_period (phase 6b, 2026-05-24)
 *
 * Pre-aggregates earnings buckets per (account, granularity) over a trailing
 * 24-month window. Replaces a 12-month reservations.collect() on every
 * dashboard mutation with a single indexed row read; the caller slices the
 * stored buckets[] tail to the requested months/weeks window.
 *
 * Refreshed by master.refreshFast (hourly). Past months/weeks are immutable
 * once closed, but the current bucket changes whenever a fresh confirmed
 * reservation lands — hourly refresh keeps the chart within an hour of
 * truth.
 */
import { v } from "convex/values";
import { query, internalMutation } from "../_generated/server";
import { ACCOUNTS, ACCOUNT_ALL } from "./constants";
import { effectiveDate, isLive } from "../lib/reservations/predicates";
import { OWNER_SHARE } from "../lib/missed_revenue";

export const GRANULARITIES = ["monthly", "weekly"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** Months of history to keep in the MV. Caller slices the tail. */
export const RETENTION_MONTHS = 24;

type ReservationLike = {
  status?: string;
  is_obsolete?: boolean;
  account_slug?: string;
  start_date?: string;
  pickup_date?: string;
  gross_paid_gbp?: number;
  net_to_owner_gbp?: number;
};

type Bucket = { period: string; revenue: number; bookings: number };

export type EarningsRow = {
  account: string;
  granularity: Granularity;
  generatedAt: number;
  buckets: Bucket[];
};

function isoMonthlyKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}

function isoWeeklyKey(dateStr: string): string {
  // ISO 8601 week — Monday-based, week 1 contains the first Thursday.
  // Mirrors the algorithm in convex/revenue.ts:getEarningsByPeriod so the
  // MV and any cold-start fallback produce identical bucket keys.
  const d = new Date(dateStr);
  const dayOfWeek = (d.getDay() + 6) % 7;
  const thursday = new Date(d);
  thursday.setDate(d.getDate() - dayOfWeek + 3);
  const jan1 = new Date(thursday.getFullYear(), 0, 1);
  const weekNum = 1 + Math.round((thursday.getTime() - jan1.getTime()) / 604_800_000);
  return thursday.getFullYear() + "-W" + String(weekNum).padStart(2, "0");
}

/**
 * Pure compute over a pre-fetched reservations window. The window MUST
 * cover at least `RETENTION_MONTHS` months back from `generatedAt` —
 * anything older is dropped on bucket-key derivation.
 */
export function computeEarningsByPeriod(args: {
  reservations: ReservationLike[];
  generatedAt: number;
}): EarningsRow[] {
  const { reservations } = args;
  const generatedAt = args.generatedAt;

  const now = new Date(generatedAt);
  const cutoffDate = new Date(now);
  cutoffDate.setMonth(cutoffDate.getMonth() - RETENTION_MONTHS);
  const cutoffISO = cutoffDate.toISOString().slice(0, 10);
  const currentMonth = now.toISOString().slice(0, 7);

  // isLive is typed against the full ReservationRow shape; cast through the
  // minimal ReservationLike for the pure compute. Same fields it actually
  // reads (status / is_obsolete) are present on both.
  const liveScoped = reservations.filter((r) =>
    isLive(r as unknown as Parameters<typeof isLive>[0]),
  );

  const rows: EarningsRow[] = [];
  const slugs = [ACCOUNT_ALL, ...ACCOUNTS];

  for (const account of slugs) {
    const scoped = account === ACCOUNT_ALL
      ? liveScoped
      : liveScoped.filter((r) => r.account_slug === account);

    for (const granularity of GRANULARITIES) {
      const buckets = new Map<string, Bucket>();
      for (const r of scoped) {
        const dateStr = effectiveDate(r);
        if (!dateStr) continue;
        if (dateStr < cutoffISO) continue;
        // Don't include future months in the earnings chart (matches the
        // live query's current-month cap).
        const effectiveMo = dateStr.slice(0, 7);
        if (effectiveMo > currentMonth) continue;
        const key = granularity === "monthly"
          ? isoMonthlyKey(dateStr)
          : isoWeeklyKey(dateStr);
        const existing = buckets.get(key) ?? { period: key, revenue: 0, bookings: 0 };
        // Earnings = owner take-home (net after ~36% platform fees), matching
        // every other revenue widget + Daniel's "earnings = take-home" rule.
        // Was summing GROSS, inflating the chart ~1.5x.
        existing.revenue += r.net_to_owner_gbp ?? (r.gross_paid_gbp ?? 0) * OWNER_SHARE;
        existing.bookings += 1;
        buckets.set(key, existing);
      }
      const sorted = Array.from(buckets.values()).sort((a, b) =>
        a.period.localeCompare(b.period),
      );
      rows.push({ account, granularity, generatedAt, buckets: sorted });
    }
  }

  return rows;
}

// Phase 2.1 — legacy `refresh` internalMutation REMOVED (no callers).
// Canonical refresh path: master.refreshFast → computeEarningsByPeriod →
// master.writeEarningsByPeriod (shared-collect, scans source tables once).

/**
 * Reader — returns the buckets covering the most recent N months.
 *
 * The cutoff math mirrors the legacy live query so the chart shows the
 * same number of bars (live used a date-based cutoff, which typically
 * includes a partial bucket for the cutoff month). The MV's first bucket
 * is a full-month total (more accurate than live's partial-month slice).
 * Document divergence — verified by mv_parity:check (2026-05-24).
 */
export const get = query({
  args: {
    account: v.optional(v.string()),
    granularity: v.union(v.literal("monthly"), v.literal("weekly")),
    months: v.number(),
  },
  handler: async (ctx, { account, granularity, months }) => {
    const key = account ?? ACCOUNT_ALL;
    const row = await ctx.db
      .query("mv_earnings_by_period")
      .withIndex("by_account_granularity", (q) =>
        q.eq("account", key).eq("granularity", granularity),
      )
      .first();
    if (!row) return null;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    if (granularity === "monthly") {
      const cutoffMonth = cutoff.toISOString().slice(0, 7);
      return row.buckets.filter((b) => b.period >= cutoffMonth);
    }
    // Weekly: derive ISO-week key for the cutoff date, then filter.
    const cutoffWeekKey = (() => {
      const d = new Date(cutoff);
      const dayOfWeek = (d.getDay() + 6) % 7;
      const thursday = new Date(d);
      thursday.setDate(d.getDate() - dayOfWeek + 3);
      const jan1 = new Date(thursday.getFullYear(), 0, 1);
      const weekNum = 1 + Math.round((thursday.getTime() - jan1.getTime()) / 604_800_000);
      return thursday.getFullYear() + "-W" + String(weekNum).padStart(2, "0");
    })();
    return row.buckets.filter((b) => b.period >= cutoffWeekKey);
  },
});

/**
 * Reactive refresh (re-added 2026-06-26). The daily-only cron left the monthly
 * income chart up to 24h stale — a confirmed booking or pickup landing during
 * the day didn't show until the next 04:00 UTC. The poller now schedules this
 * on any booking change / realised-revenue (convex/hygglo.ts), so the chart
 * converges within seconds. Recomputes all (account, granularity) rows from a
 * single reservations collect — same shape as master.writeEarningsByPeriod.
 */
export const refresh = internalMutation({
  args: {},
  handler: async (ctx) => {
    const reservations = await ctx.db.query("reservations").collect();
    const rows = computeEarningsByPeriod({ reservations, generatedAt: Date.now() });
    for (const r of rows) {
      const existing = await ctx.db
        .query("mv_earnings_by_period")
        .withIndex("by_account_granularity", (q) =>
          q.eq("account", r.account).eq("granularity", r.granularity),
        )
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, {
          generatedAt: r.generatedAt,
          buckets: r.buckets,
        });
      } else {
        await ctx.db.insert("mv_earnings_by_period", {
          account: r.account,
          granularity: r.granularity,
          generatedAt: r.generatedAt,
          buckets: r.buckets,
        });
      }
    }
  },
});
