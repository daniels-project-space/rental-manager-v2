/**
 * MV: mv_earnings_by_period (phase 6b, 2026-05-24)
 *
 * Pre-aggregates earnings buckets per (account, granularity) over a trailing
 * 24-month window. Replaces a 12-month reservations.collect() on every
 * dashboard mutation with a single indexed row read; the caller slices the
 * stored buckets[] tail to the requested months/weeks window.
 *
 * Booking changes update their affected monthly/weekly buckets directly.
 * The daily slow refresh remains a full reconciliation for changes made by
 * other reservation writers and for calendar-window rollover.
 */
import { v } from "convex/values";
import { query, internalMutation } from "../owner_functions";
import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
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

export type EarningsContribution = {
  accountSlug: string | null;
  date: string;
  revenue: number;
};

export type EarningsContributionChange = {
  before: EarningsContribution | null;
  after: EarningsContribution | null;
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

/** Preserve the exact inclusion and value rules used by the full MV rebuild. */
export function getEarningsContribution(
  reservation: ReservationLike,
): EarningsContribution | null {
  if (!isLive(reservation as Parameters<typeof isLive>[0])) return null;
  const date = effectiveDate(reservation);
  if (!date) return null;
  return {
    accountSlug: reservation.account_slug ?? null,
    date,
    revenue: reservation.net_to_owner_gbp ??
      (reservation.gross_paid_gbp ?? 0) * OWNER_SHARE,
  };
}

/**
 * Apply booking-level deltas to already-computed buckets. A null result means
 * the existing snapshot cannot safely accept a delta and needs a full rebuild.
 */
export function applyEarningsContributionChanges(
  currentRows: EarningsRow[],
  changes: EarningsContributionChange[],
  generatedAt: number,
): EarningsRow[] | null {
  const expectedAccounts = [ACCOUNT_ALL, ...ACCOUNTS];
  const rowsByKey = new Map(currentRows.map((row) => [`${row.account}:${row.granularity}`, row]));
  for (const account of expectedAccounts) {
    for (const granularity of GRANULARITIES) {
      if (!rowsByKey.has(`${account}:${granularity}`)) return null;
    }
  }

  const cutoffDate = new Date(generatedAt);
  cutoffDate.setMonth(cutoffDate.getMonth() - RETENTION_MONTHS);
  const cutoffISO = cutoffDate.toISOString().slice(0, 10);
  const currentMonth = new Date(generatedAt).toISOString().slice(0, 7);
  const deltas = new Map<string, Map<string, { revenue: number; bookings: number }>>();

  const addContribution = (contribution: EarningsContribution | null, sign: 1 | -1) => {
    if (!contribution || contribution.date < cutoffISO || contribution.date.slice(0, 7) > currentMonth) return;
    const accountScopes = new Set<string>([ACCOUNT_ALL]);
    if (contribution.accountSlug && ACCOUNTS.includes(contribution.accountSlug as (typeof ACCOUNTS)[number])) {
      accountScopes.add(contribution.accountSlug);
    }
    for (const account of accountScopes) {
      for (const granularity of GRANULARITIES) {
        const rowKey = `${account}:${granularity}`;
        const period = granularity === "monthly"
          ? isoMonthlyKey(contribution.date)
          : isoWeeklyKey(contribution.date);
        const buckets = deltas.get(rowKey) ?? new Map<string, { revenue: number; bookings: number }>();
        const delta = buckets.get(period) ?? { revenue: 0, bookings: 0 };
        delta.revenue += sign * contribution.revenue;
        delta.bookings += sign;
        if (delta.revenue === 0 && delta.bookings === 0) buckets.delete(period);
        else buckets.set(period, delta);
        if (buckets.size === 0) deltas.delete(rowKey);
        else deltas.set(rowKey, buckets);
      }
    }
  };

  for (const change of changes) {
    addContribution(change.before, -1);
    addContribution(change.after, 1);
  }

  if (deltas.size === 0) return currentRows;

  const updated: EarningsRow[] = [];
  for (const row of currentRows) {
    const bucketDeltas = deltas.get(`${row.account}:${row.granularity}`);
    if (!bucketDeltas) {
      updated.push(row);
      continue;
    }
    const buckets = new Map(row.buckets.map((bucket) => [bucket.period, { ...bucket }]));
    for (const [period, delta] of bucketDeltas) {
      const existing = buckets.get(period) ?? { period, revenue: 0, bookings: 0 };
      const next = {
        period,
        revenue: existing.revenue + delta.revenue,
        bookings: existing.bookings + delta.bookings,
      };
      if (next.bookings < 0 || (next.bookings === 0 && Math.abs(next.revenue) > 0.01)) return null;
      if (next.bookings === 0) buckets.delete(period);
      else buckets.set(period, next);
    }
    updated.push({
      ...row,
      generatedAt,
      buckets: Array.from(buckets.values()).sort((a, b) => a.period.localeCompare(b.period)),
    });
  }
  return updated;
}

/** Keep the chart current on booking writes without collecting reservations. */
export async function applyReservationEarningsChanges(
  ctx: MutationCtx,
  changes: EarningsContributionChange[],
  generatedAt = Date.now(),
): Promise<void> {
  if (changes.length === 0) return;
  const accounts = [ACCOUNT_ALL, ...ACCOUNTS];
  const storedRows: Doc<"mv_earnings_by_period">[] = [];
  for (const account of accounts) {
    for (const granularity of GRANULARITIES) {
      const row = await ctx.db
        .query("mv_earnings_by_period")
        .withIndex("by_account_granularity", (q) =>
          q.eq("account", account).eq("granularity", granularity),
        )
        .first();
      if (row) storedRows.push(row);
    }
  }
  const currentRows = storedRows.map(({ account, granularity, generatedAt: rowAt, buckets }) => ({
    account,
    granularity,
    generatedAt: rowAt,
    buckets,
  })) as EarningsRow[];
  const nextRows = applyEarningsContributionChanges(currentRows, changes, generatedAt);

  // Do not put the exceptional full source scan in the booking transaction:
  // it could make a normal poll exceed its read budget as the table grows.
  // The existing standalone refresh owns this recovery scan and retries safely.
  if (!nextRows) {
    await ctx.scheduler.runAfter(0, internal.mv.earnings_by_period.refresh, {});
    return;
  }
  const storedByKey = new Map(storedRows.map((row) => [`${row.account}:${row.granularity}`, row]));
  for (const row of nextRows) {
    const prior = storedByKey.get(`${row.account}:${row.granularity}`);
    if (
      prior &&
      JSON.stringify(row.buckets) === JSON.stringify(prior.buckets)
    ) continue;
    if (prior) await ctx.db.patch(prior._id, { generatedAt: row.generatedAt, buckets: row.buckets });
    else await ctx.db.insert("mv_earnings_by_period", row);
  }
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
    const reservations = await ctx.db.query("reservations").collect(); // check-patterns:ok — MV builder — lifetime buckets need the full table (manual/dispatch path; daily cron uses master's shared collect)
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
