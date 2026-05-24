/**
 * MV: mv_missed_revenue (phase 6a, 2026-05-24)
 *
 * Pre-aggregates denial-losses + idle-gap-losses per (account, days) so the
 * dashboard MissedRevenue panel and the top-tile in getStatsDrawerData read
 * a single indexed row instead of collecting `denial_records` +
 * `pricing_catalog` + 30d `reservations` on every poller mutation.
 *
 * Refreshed by master.refreshFast (hourly). Cold-start fallback: callers
 * may re-run the live compute helper if the MV row is absent — the row
 * lands on the first cron tick after deploy.
 *
 * Shape mirrors `convex/lib/missed_revenue.ts:MissedRevenueResult` so the
 * existing query handlers can swap the source verbatim.
 */
import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { ACCOUNTS, ACCOUNT_ALL } from "./constants";
import { OWNER_SHARE } from "../lib/missed_revenue";

export const WINDOWS_DAYS = [30, 90] as const;
export type MissedRevenueWindow = (typeof WINDOWS_DAYS)[number];

type DenialLikeRow = {
  _id: string;
  estimated_value?: number;
  item_name?: string;
  reason?: string;
  notes?: string;
  account_id?: string;
  created_at: number;
};

type PricingRow = { item_name_canonical: string; daily_price_min: number };

type ReservationLike = {
  account_slug?: string;
  start_date?: string;
  duration_days?: number;
  items?: Array<{ item_name: string }>;
};

type AccountRow = { _id: string; slug: string };

type DenialLossRow = {
  denialId: string;
  reason?: string;
  itemName?: string;
  estimatedValue: number;
  estimatedValueGross: number;
  notes?: string;
  createdAt: number;
};

type GapLossRow = {
  itemName: string;
  rentalDays: number;
  idleDays: number;
  estimatedGapLoss: number;
};

export type MissedRevenueRow = {
  account: string;
  days: number;
  generatedAt: number;
  totalMissed: number;
  denialTotal: number;
  gapTotal: number;
  denialLosses: DenialLossRow[];
  gapLosses: GapLossRow[];
};

/**
 * Pure compute over pre-fetched inputs — used by master.ts shared-collect.
 * Returns one row per (account × days) combination. `account = "all"` is
 * the cross-account aggregate.
 */
export function computeMissedRevenue(args: {
  denials: DenialLikeRow[];
  pricing: PricingRow[];
  reservations: ReservationLike[];
  accounts: AccountRow[];
  generatedAt: number;
  windows?: readonly number[];
}): MissedRevenueRow[] {
  const { denials, pricing, reservations, accounts } = args;
  const generatedAt = args.generatedAt;
  const windows = args.windows ?? WINDOWS_DAYS;

  const accountIdBySlug = new Map<string, string>();
  for (const acc of accounts) accountIdBySlug.set(acc.slug, acc._id);

  const priceByName = new Map<string, number>();
  for (const p of pricing) priceByName.set(p.item_name_canonical, p.daily_price_min);

  const slugs = [ACCOUNT_ALL, ...ACCOUNTS];
  const rows: MissedRevenueRow[] = [];

  for (const days of windows) {
    const cutoffMs = generatedAt - days * 86_400_000;
    const cutoffISO = new Date(cutoffMs).toISOString().slice(0, 10);

    for (const account of slugs) {
      const accountId = account === ACCOUNT_ALL ? null : accountIdBySlug.get(account);
      // ── Denial losses ──────────────────────────────────────
      const scopedDenials = denials.filter((d) => {
        if (d.created_at < cutoffMs) return false;
        if (account === ACCOUNT_ALL) return true;
        if (!accountId) return false;
        return d.account_id === accountId;
      });

      const denialLosses: DenialLossRow[] = scopedDenials.map((d) => {
        let estimatedValueGross = d.estimated_value ?? 0;
        if (estimatedValueGross === 0 && d.item_name) {
          const priceRow = priceByName.get(d.item_name);
          if (priceRow !== undefined) {
            // Match live helper: assume 2-day average rental when denial
            // record is missing a manual estimate.
            estimatedValueGross = priceRow * 2;
          }
        }
        const estimatedValue = parseFloat(
          (estimatedValueGross * OWNER_SHARE).toFixed(2),
        );
        return {
          denialId: d._id,
          reason: d.reason,
          itemName: d.item_name,
          estimatedValue,
          estimatedValueGross,
          notes: d.notes,
          createdAt: d.created_at,
        };
      });

      const denialTotal = parseFloat(
        denialLosses.reduce((s, d) => s + d.estimatedValue, 0).toFixed(2),
      );

      // ── Idle-gap losses ────────────────────────────────────
      const scopedReservations = account === ACCOUNT_ALL
        ? reservations.filter((r) => r.start_date && r.start_date >= cutoffISO)
        : reservations.filter(
            (r) =>
              r.account_slug === account &&
              r.start_date &&
              r.start_date >= cutoffISO,
          );

      const rentalDaysPerItem = new Map<string, number>();
      for (const r of scopedReservations) {
        for (const item of r.items ?? []) {
          rentalDaysPerItem.set(
            item.item_name,
            (rentalDaysPerItem.get(item.item_name) ?? 0) + (r.duration_days ?? 0),
          );
        }
      }

      const gapLosses: GapLossRow[] = [];
      for (const [itemName, rentalDays] of rentalDaysPerItem.entries()) {
        const idleDays = Math.max(0, days - Math.min(rentalDays, days));
        if (idleDays <= 0) continue;
        const dailyRate = priceByName.get(itemName);
        if (!dailyRate) continue;
        gapLosses.push({
          itemName,
          rentalDays,
          idleDays,
          estimatedGapLoss: parseFloat(
            (idleDays * dailyRate * OWNER_SHARE).toFixed(2),
          ),
        });
      }
      gapLosses.sort((a, b) => b.estimatedGapLoss - a.estimatedGapLoss);

      const gapTotal = parseFloat(
        gapLosses.reduce((s, g) => s + g.estimatedGapLoss, 0).toFixed(2),
      );
      const totalMissed = parseFloat((denialTotal + gapTotal).toFixed(2));

      rows.push({
        account,
        days,
        generatedAt,
        totalMissed,
        denialTotal,
        gapTotal,
        denialLosses,
        gapLosses,
      });
    }
  }

  return rows;
}

/**
 * Standalone refresh — direct invocation path (ops, manual triggers).
 * The hot path goes through master.refreshFast which reuses its
 * pre-fetched collects. Both call computeMissedRevenue() and write via
 * the master.writeMissedRevenue mutation.
 */
export const refresh = internalMutation({
  args: {},
  handler: async (ctx) => {
    const startedAt = Date.now();
    const cutoff90 = new Date(startedAt - 90 * 86_400_000).toISOString().slice(0, 10);
    const [denials, pricing, reservations, accounts] = await Promise.all([
      ctx.db.query("denial_records").collect(),
      ctx.db.query("pricing_catalog").collect(),
      ctx.db.query("reservations")
        .withIndex("by_start_date", (q) => q.gte("start_date", cutoff90))
        .collect(),
      ctx.db.query("accounts").collect(),
    ]);
    const rows = computeMissedRevenue({
      denials: denials as unknown as DenialLikeRow[],
      pricing: pricing as unknown as PricingRow[],
      reservations: reservations as unknown as ReservationLike[],
      accounts: accounts as unknown as AccountRow[],
      generatedAt: startedAt,
    });
    let written = 0;
    for (const row of rows) {
      const { account, days, ...rest } = row;
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
      written += 1;
    }
    return { ok: true, written, durationMs: Date.now() - startedAt };
  },
});

/**
 * Read the cached row for (account, days). Returns null if not yet
 * refreshed — callers should fall back to the live compute helper until
 * the first cron tick lands.
 */
export const get = query({
  args: {
    account: v.optional(v.string()),
    days: v.number(),
  },
  handler: async (ctx, { account, days }) => {
    const key = account ?? ACCOUNT_ALL;
    const row = await ctx.db
      .query("mv_missed_revenue")
      .withIndex("by_account_days", (q) =>
        q.eq("account", key).eq("days", days),
      )
      .first();
    return row;
  },
});
