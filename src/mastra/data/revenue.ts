/**
 * Revenue / dashboard summary / BI / earnings-ranking / bundle / tax reads.
 *
 * Wave 1: getDashboardStats, getBusinessIntelligence, getCurrentBriefing (stub).
 * Wave 2 (this PR):
 *   - getDashboardStats: ADDS netToOwner series + insurancePayouts series +
 *     ISO-week buckets (Q2). Pre-existing fields unchanged.
 *   - NEW: getTopEarningItems, getItemEarningsHistory, getRevenueSummary,
 *     getTopBundles, getItemCycle, getTaxSummary (6 functions; V1 audit §5).
 *
 * Every fn accepts optional `account` (Q3). Omitted = combined across both.
 */
import "server-only";
import { anyApi } from "convex/server";
import { getConvex, toError } from "./client";
import { getSyncState, wrap, type ToolEnvelope } from "./envelope";
import { validateAccount, type AccountSlug } from "./account-scope";
import { PLATFORM_FEE_RATE } from "./constants";

type Result<T> = ToolEnvelope<T> | { ok: false; error: string };

/**
 * ISO-week key (YYYY-Www) for a JS Date.
 * Avoids `date-fns` dependency (not in package.json). Mirrors the inline ISO
 * implementation already used by `convex/revenue.ts:getEarningsByPeriod` so
 * the two surfaces produce identical week keys.
 */
function isoWeekKey(d: Date): string {
  // ISO: Monday-based, week 1 = week containing first Thursday.
  const dayOfWeek = (d.getDay() + 6) % 7; // Mon=0 .. Sun=6
  const thursday = new Date(d);
  thursday.setDate(d.getDate() - dayOfWeek + 3);
  const jan1 = new Date(thursday.getFullYear(), 0, 1);
  const weekNum =
    1 + Math.round((thursday.getTime() - jan1.getTime()) / 604800000);
  return `${thursday.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Wave 1 carry-overs (now account-scoped + briefing-expanded)
// ─────────────────────────────────────────────────────────────────────────

export async function getDashboardStats(input?: {
  account?: AccountSlug | null;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const accountSlug = validateAccount(input?.account);
    // Pull weekly buckets (last 3 months ISO) + insurance claims in parallel
    // so the dashboard stat call doubles as the daily-briefing series feed.
    const [stats, weekly, claims, syncState] = await Promise.all([
      convex.query(anyApi.dashboard.getSummary, { accountSlug }),
      convex.query(anyApi.revenue.getEarningsByPeriod, {
        accountSlug,
        granularity: "weekly",
        months: 3,
      }),
      convex.query(anyApi.insurance_claims.list, {
        accountSlug: accountSlug ?? undefined,
      }),
      getSyncState(),
    ]);

    // Net-to-owner series: apply PLATFORM_FEE_RATE against gross per bucket.
    // The Convex getEarningsByPeriod doesn't yet expose per-bucket delivery
    // fees; we surface that as a caveat instead of inventing a value.
    const netToOwner = (
      weekly as Array<{ period: string; revenue: number; bookings: number }>
    ).map((row) => {
      const gross = row.revenue;
      const fee = Math.round(gross * PLATFORM_FEE_RATE * 100) / 100;
      const net = Math.round((gross - fee) * 100) / 100;
      return {
        period: row.period, // already ISO YYYY-Www
        gross: Math.round(gross * 100) / 100,
        fee,
        deliveryFee: 0,
        net,
        bookings: row.bookings,
      };
    });

    const insurancePayouts = (
      claims as Array<{ claimDate: string; amountGbp: number }>
    ).map((c) => ({
      date: c.claimDate,
      amount: c.amountGbp,
    }));

    return wrap({
      data: {
        ok: true as const,
        // Wave 1 fields — DO NOT MODIFY (backwards compatible)
        today_revenue: stats.todayRevenue,
        today_rental_count: stats.todayRentalCount,
        weekly_revenue: stats.weeklyRevenue,
        monthly_revenue: stats.monthlyRevenue,
        projected_month_revenue: stats.projectedMonthRevenue,
        active_rentals: stats.activeRentalsCount,
        ongoing: stats.ongoingCount,
        upcoming: stats.upcomingCount,
        overdue: stats.overdueCount,
        items_out: stats.itemsOut,
        available_items: stats.availableItems,
        out_of_stock_count: stats.outOfStockCount,
        denial_rate: stats.denialRate,
        denied_revenue_90d: stats.deniedRevenue,
        // Wave 2 expansion (Q2)
        net_to_owner_weekly: netToOwner,
        insurance_payouts: insurancePayouts,
        weekly_bucketing: "iso-week" as const,
      },
      source:
        "convex.dashboard.getSummary+revenue.getEarningsByPeriod+insurance_claims.list",
      syncState,
      extraCaveats: [
        "net_to_owner_weekly applies PLATFORM_FEE_RATE=0.36 against gross; delivery fee is set to 0 (per-bucket delivery-fee aggregation is a Wave 2.5 follow-up — schema captures delivery_fee_gbp per reservation, no bucketed Convex query yet).",
      ],
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

export async function getBusinessIntelligence(input?: {
  account?: AccountSlug | null;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const accountSlug = validateAccount(input?.account);
    const [sell, price, insights, syncState] = await Promise.all([
      convex.query(anyApi.items.getSellRecommendations, { accountSlug }),
      convex.query(anyApi.items.getPriceRecommendations, { accountSlug }),
      convex.query(anyApi.ai_insights.getInsights, { accountSlug }),
      getSyncState(),
    ]);
    return wrap({
      data: {
        ok: true as const,
        underutilizedItems: (sell as unknown[]).slice(0, 10),
        priceSuggestions: (price as unknown[]).slice(0, 10),
        insights,
      },
      source: "convex.ai_insights+items",
      syncState,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Wave 2 — 6 new revenue functions (V1 audit §5)
// ─────────────────────────────────────────────────────────────────────────

const DAYS_PER_RANGE: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "6m": 180,
  "1y": 365,
  all: 3650,
};

function rangeToDays(range?: string): number {
  return DAYS_PER_RANGE[range ?? "30d"] ?? 30;
}

/**
 * V1 source: src/revenue/revenue.service.ts:817 getTopEarningItems
 * V2 backing query: convex.items.getItemRevenueRanking (already exists).
 */
export async function getTopEarningItems(input?: {
  range?: string;
  account?: AccountSlug | null;
  limit?: number;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const accountSlug = validateAccount(input?.account);
    const days = rangeToDays(input?.range);
    const limit = input?.limit ?? 10;
    const [rows, syncState] = await Promise.all([
      convex.query(anyApi.items.getItemRevenueRanking, { accountSlug, days }),
      getSyncState(),
    ]);
    const top = (rows as unknown[]).slice(0, limit);
    return wrap({
      data: { ok: true as const, range: input?.range ?? "30d", items: top },
      source: "convex.items.getItemRevenueRanking",
      syncState,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

/**
 * V1 source: src/revenue/revenue.service.ts:1911 getItemEarningsHistory
 * Returns real per-month buckets for the item over the requested range,
 * powered by convex.items.getItemMonthlyEarnings (Wave 2.5 - shipped).
 */
export async function getItemEarningsHistory(input: {
  itemName: string;
  range?: string;
  account?: AccountSlug | null;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const accountSlug = validateAccount(input.account);
    const days = rangeToDays(input.range);
    // Map day range to months (1, 3, 6, 12, 24, 36); default 12.
    const months =
      days <= 31 ? 1 :
      days <= 92 ? 3 :
      days <= 183 ? 6 :
      days <= 366 ? 12 :
      days <= 731 ? 24 : 36;
    const [resp, syncState] = await Promise.all([
      convex.query(anyApi.items.getItemMonthlyEarnings, {
        item_name: input.itemName,
        months,
        account_slug: accountSlug ?? undefined,
      }),
      getSyncState(),
    ]);
    const r = resp as
      | { ok: true; item: { name: string }; monthly: Array<{ month: string; grossGbp: number; netGbp: number; rentalCount: number; totalDays: number }>; totals: { grossGbp: number; netGbp: number; rentalCount: number; totalDays: number } }
      | { ok: false; error: string; item_name: string };
    if (!r.ok) {
      return wrap({
        data: { ok: false as const, itemName: input.itemName, range: input.range ?? "30d", history: [] },
        source: "convex.items.getItemMonthlyEarnings (not found)",
        syncState,
      });
    }
    return wrap({
      data: {
        ok: true as const,
        itemName: r.item.name,
        range: input.range ?? "30d",
        months,
        totals: r.totals,
        history: r.monthly.map((m) => ({
          period: m.month,
          revenue: m.grossGbp,
          netRevenue: m.netGbp,
          rentalCount: m.rentalCount,
          totalDays: m.totalDays,
          avgValue:
            m.rentalCount > 0
              ? Math.round((m.grossGbp / m.rentalCount) * 100) / 100
              : 0,
        })),
      },
      source: "convex.items.getItemMonthlyEarnings",
      syncState,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

/**
 * V1 source: src/revenue/revenue.service.ts:240 getRevenueForPeriod
 * Maps period -> days, returns aggregate from dashboard.getSummary (week/month)
 * or revenue.getLifetimeByMonth (all).
 */
export async function getRevenueSummary(input: {
  period: "week" | "month" | "all";
  account?: AccountSlug | null;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const accountSlug = validateAccount(input.account);
    const [stats, syncState] = await Promise.all([
      convex.query(anyApi.dashboard.getSummary, { accountSlug }),
      getSyncState(),
    ]);
    const s = stats as {
      todayRevenue: number;
      weeklyRevenue: number;
      monthlyRevenue: number;
      monthlyBookings: number;
      avgRentalValue: number;
    };
    let revenue: number;
    let bookings: number | null;
    if (input.period === "week") {
      revenue = s.weeklyRevenue;
      bookings = null;
    } else if (input.period === "month") {
      revenue = s.monthlyRevenue;
      bookings = s.monthlyBookings;
    } else {
      const lifetime = (await convex.query(anyApi.revenue.getLifetimeByMonth, {
        accountSlug,
      })) as { totalRevenue: number };
      revenue = lifetime.totalRevenue;
      bookings = null;
    }
    return wrap({
      data: {
        ok: true as const,
        period: input.period,
        revenue,
        bookings,
        avgRentalValue: s.avgRentalValue,
      },
      source:
        input.period === "all"
          ? "convex.revenue.getLifetimeByMonth"
          : "convex.dashboard.getSummary",
      syncState,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

/**
 * V1 source: src/revenue/revenue.service.ts:2208 getTopBundles
 * V2 backing query: convex.bundles.getTopBundles
 */
export async function getTopBundles(input?: {
  range?: string;
  account?: AccountSlug | null;
  limit?: number;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const accountSlug = validateAccount(input?.account);
    const days = rangeToDays(input?.range);
    const limit = input?.limit ?? 20;
    const [rows, syncState] = await Promise.all([
      convex.query(anyApi.bundles.getTopBundles, { accountSlug, days }),
      getSyncState(),
    ]);
    return wrap({
      data: {
        ok: true as const,
        range: input?.range ?? "30d",
        bundles: (rows as unknown[]).slice(0, limit),
      },
      source: "convex.bundles.getTopBundles",
      syncState,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

/**
 * V1 source: src/revenue/revenue.service.ts:2424 getItemCycleData (ROI focus).
 * Composes acquisition_cost_gbp (items.listActive) + lifetime earnings
 * (items.getItemRevenueRanking with 10y window) for the named item.
 * Returns { acquisitionCost, lifetimeRevenue, netProfit, roiPct, rentalCount }.
 */
export async function getItemCycle(input: {
  itemName: string;
  account?: AccountSlug | null;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const accountSlug = validateAccount(input.account);
    const [allItems, ranking, syncState] = await Promise.all([
      convex.query(anyApi.items.listActive, {}),
      convex.query(anyApi.items.getItemRevenueRanking, {
        accountSlug,
        days: 3650,
      }),
      getSyncState(),
    ]);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const target = norm(input.itemName);
    const item = (
      allItems as Array<{
        name_canonical: string;
        acquisition_cost_gbp?: number;
      }>
    ).find((i) => norm(i.name_canonical).includes(target));
    const earn = (
      ranking as Array<{
        name: string;
        totalRevenue: number;
        rentalCount: number;
        totalDays: number;
      }>
    ).find((r) => norm(r.name).includes(target));
    const acquisitionCost = item?.acquisition_cost_gbp ?? null;
    const lifetimeRevenue = earn?.totalRevenue ?? 0;
    const netProfit =
      acquisitionCost !== null ? lifetimeRevenue - acquisitionCost : null;
    const roiPct =
      acquisitionCost && acquisitionCost > 0
        ? (lifetimeRevenue / acquisitionCost) * 100
        : null;
    return wrap({
      data: {
        ok: true as const,
        itemName: input.itemName,
        canonicalName: item?.name_canonical ?? null,
        acquisitionCost,
        lifetimeRevenue: Math.round(lifetimeRevenue * 100) / 100,
        netProfit:
          netProfit !== null ? Math.round(netProfit * 100) / 100 : null,
        roiPct: roiPct !== null ? Math.round(roiPct * 10) / 10 : null,
        rentalCount: earn?.rentalCount ?? 0,
        totalDays: earn?.totalDays ?? 0,
      },
      source: "convex.items.listActive+items.getItemRevenueRanking",
      syncState,
      extraCaveats: !item
        ? ["Item not found in active inventory — acquisitionCost is null."]
        : undefined,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

/**
 * V1 source: src/revenue/revenue.service.ts:2737 getTaxSummary
 * Composes monthly revenue (historical_revenue + reservations via
 * getLifetimeByMonth) for the UK fiscal year (6 Apr -> 5 Apr).
 * Returns monthly breakdown + total.
 *
 * Wave 2.5 follow-up: a dedicated convex.revenue.getTaxSummary query that
 * applies precise UK fiscal-year cut-offs server-side would be cleaner.
 */
export async function getTaxSummary(input?: {
  taxYear?: number;
  account?: AccountSlug | null;
}): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const accountSlug = validateAccount(input?.account);
    const [lifetime, syncState] = await Promise.all([
      convex.query(anyApi.revenue.getLifetimeByMonth, { accountSlug }),
      getSyncState(),
    ]);
    const taxYear =
      input?.taxYear ??
      (() => {
        const now = new Date();
        // UK tax year starts 6 April. Year-label = starting calendar year.
        return now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
      })();
    // Tax year window: YYYY-04 .. (YYYY+1)-03 inclusive.
    const start = `${taxYear}-04`;
    const end = `${taxYear + 1}-03`;
    const months = (
      lifetime as {
        months: Array<{
          month: string;
          dbcinemaOrganic: number;
          leoOrganic: number;
          aiBoost: number;
          damageClaims: number;
        }>;
      }
    ).months.filter((m) => m.month >= start && m.month <= end);
    const totalRevenue = months.reduce(
      (s, m) =>
        s + m.dbcinemaOrganic + m.leoOrganic + m.aiBoost + m.damageClaims,
      0,
    );
    return wrap({
      data: {
        ok: true as const,
        taxYear,
        windowStart: start,
        windowEnd: end,
        months,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
      },
      source: "convex.revenue.getLifetimeByMonth (tax-year filtered)",
      syncState,
      extraCaveats: [
        "UK tax year window applied client-side (6 Apr cutoff). Wave 2.5 will add a server-side convex.revenue.getTaxSummary with exact date cutoffs.",
      ],
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

