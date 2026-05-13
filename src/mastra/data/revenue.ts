/**
 * Revenue / dashboard summary / BI reads.
 * Wave 2 will expand getCurrentBriefing with additional series (insurance,
 * net-to-owner) — left as a stub-comment for now.
 */
import "server-only";
import { anyApi } from "convex/server";
import { getConvex, toError } from "./client";
import { getSyncState, wrap, type ToolEnvelope } from "./envelope";

type Result<T> = ToolEnvelope<T> | { ok: false; error: string };

export async function getDashboardStats(): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [stats, syncState] = await Promise.all([
      convex.query(anyApi.dashboard.getSummary, { accountSlug: null }),
      getSyncState(),
    ]);
    return wrap({
      data: {
        ok: true as const,
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
      },
      source: "convex.dashboard.getSummary",
      syncState,
    });
  } catch (err) {
    return { ok: false as const, error: toError(err) };
  }
}

export async function getBusinessIntelligence(): Promise<Result<unknown>> {
  try {
    const convex = getConvex();
    const [sell, price, insights, syncState] = await Promise.all([
      convex.query(anyApi.items.getSellRecommendations, { accountSlug: null }),
      convex.query(anyApi.items.getPriceRecommendations, { accountSlug: null }),
      convex.query(anyApi.ai_insights.getInsights, { accountSlug: null }),
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

/**
 * STUB — Wave 2 will expand this with extra series (net-to-owner, insurance
 * payouts, weekly granularity fix per gap audit W04). For now it simply
 * defers to getDashboardStats so callers can already wire the import.
 */
export async function getCurrentBriefing(): Promise<Result<unknown>> {
  return getDashboardStats();
}
