import { query } from "./_generated/server";
import { v } from "convex/values";
import { effectiveDate } from "./lib/reservations/predicates";

/**
 * W18 AI Investment Insights — deterministic aggregations from real data.
 * Returns 4-5 insight objects with headline and body derived from
 * actual Convex data (no LLM calls).
 */
export const getInsights = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    // Set ONLY by mv/ai_insights.ts:refreshAll to run the live compute below
    // instead of reading the cache (avoids a reader→MV→reader loop). Public
    // callers leave it undefined and get the cached daily row.
    _bypassMv: v.optional(v.boolean()),
  },
  handler: async (ctx, { accountSlug, _bypassMv }) => {
    if (!_bypassMv) {
      // Cached path — one indexed row written daily by master.refreshSlow.
      // Falls through to the live compute on a cold MV (post-deploy tick).
      const cached = await ctx.db
        .query("mv_ai_insights")
        .withIndex("by_account", (q) => q.eq("account", accountSlug ?? "all"))
        .first();
      if (cached) {
        return cached.payload as { headline: string; body: string; kind: string }[];
      }
    }
    const insights: { headline: string; body: string; kind: string }[] = [];

    const sixtyDaysAgoStr = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    const ninetyDaysAgoStr = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

    // 365d cutoff: the insights here use 30d / 60d / 90d windows only, so
    // anything older than a year is dead weight. ~6× bandwidth saving.
    const aiCutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    let allReservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", aiCutoff))
      .collect();
    if (accountSlug) {
      allReservations = allReservations.filter((r) => r.account_slug === accountSlug);
    }

    const allItems = await ctx.db.query("items").collect();
    const activeItems = allItems.filter(
      (i) => i.status === "active" && !i.is_marketing_only
    );

    // Insight 1: Revenue trend rolling 30d vs prior 30d (avoids spurious 100% drops at month start)
    const thirtyDaysAgoStr2 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const sixtyDaysAgoStr2 = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    const todayStr2 = new Date().toISOString().slice(0, 10);

    const rolling30Revenue = allReservations
      .filter((r) => {
        const d = effectiveDate(r as any);
        return d !== undefined && d >= thirtyDaysAgoStr2 && d <= todayStr2;
      })
      .reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);

    const prior30Revenue = allReservations
      .filter((r) => {
        const d = effectiveDate(r as any);
        return d !== undefined && d >= sixtyDaysAgoStr2 && d < thirtyDaysAgoStr2;
      })
      .reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);

    if (prior30Revenue > 0) {
      const pctChange = ((rolling30Revenue - prior30Revenue) / prior30Revenue) * 100;
      const dir = pctChange >= 0 ? "up" : "down";
      const absPct = Math.abs(pctChange).toFixed(0);
      const comment =
        pctChange >= 10
          ? "Strong momentum — consider expanding capacity."
          : pctChange <= -10
          ? "Revenue declining — review pricing and availability."
          : "Revenue is broadly stable over rolling 30 days.";
      insights.push({
        kind: "revenue_trend",
        headline: "Revenue " + dir + " " + absPct + "% vs prior 30 days",
        body:
          "Rolling 30d: £" + rolling30Revenue.toFixed(0) +
          " vs prior 30d: £" + prior30Revenue.toFixed(0) + ". " + comment,
      });
    } else if (rolling30Revenue > 0) {
      insights.push({
        kind: "revenue_trend",
        headline: "£" + rolling30Revenue.toFixed(0) + " in last 30 days",
        body: "Prior period data unavailable for comparison.",
      });
    }

    // Insight 2: Items with 0 bookings in 60 days
    const recentRes = allReservations.filter(
      (r) => r.start_date !== undefined && r.start_date >= sixtyDaysAgoStr
    );
    const itemsRentedRecently = new Set<string>();
    for (const r of recentRes) {
      for (const item of r.items ?? []) {
        itemsRentedRecently.add(item.item_name);
      }
    }
    const idleItems = activeItems.filter(
      (i) => !itemsRentedRecently.has(i.name_canonical)
    );
    if (idleItems.length > 0) {
      const topIdle = idleItems
        .sort((a, b) => (b.acquisition_cost_gbp ?? 0) - (a.acquisition_cost_gbp ?? 0))
        .slice(0, 3)
        .map((i) => i.name_canonical);
      insights.push({
        kind: "idle_items",
        headline:
          idleItems.length +
          " item" +
          (idleItems.length !== 1 ? "s" : "") +
          " with no bookings in 60 days",
        body:
          "Idle inventory ties up capital. Highest-value idle items: " +
          topIdle.join(", ") +
          ". Consider promotional pricing or listing on additional platforms.",
      });
    }

    // Insight 3: Top revenue performers last 90 days
    const last90Res = allReservations.filter(
      (r) => r.start_date !== undefined && r.start_date >= ninetyDaysAgoStr
    );
    const revenueByItem = new Map<string, number>();
    for (const r of last90Res) {
      const items = r.items ?? [];
      if (items.length === 0) continue;
      const share = (r.gross_paid_gbp ?? 0) / items.length;
      for (const item of items) {
        revenueByItem.set(
          item.item_name,
          (revenueByItem.get(item.item_name) ?? 0) + share
        );
      }
    }
    const topPerformers = Array.from(revenueByItem.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);

    if (topPerformers.length > 0) {
      const totalLast90 = last90Res.reduce(
        (s, r) => s + (r.gross_paid_gbp ?? 0),
        0
      );
      const top5Revenue = topPerformers.reduce((s, [, revVal]) => s + revVal, 0);
      const concentrationPct =
        totalLast90 > 0
          ? Math.round((top5Revenue / totalLast90) * 100)
          : 0;
      const leaders = topPerformers
        .slice(0, 3)
        .map(([n, revVal]) => n + " (£" + revVal.toFixed(0) + ")")
        .join(", ");
      insights.push({
        kind: "top_performers",
        headline:
          "Top 5 items drive " + concentrationPct + "% of revenue (90 days)",
        body:
          "Leading earners: " +
          leaders +
          ". High concentration means risk if any one item is unavailable.",
      });
    }

    // Insight 4: Under-utilised high-cost items
    const UTIL_WINDOW = 90;
    const rentalDaysMap = new Map<string, number>();
    for (const r of last90Res) {
      for (const item of r.items ?? []) {
        rentalDaysMap.set(
          item.item_name,
          (rentalDaysMap.get(item.item_name) ?? 0) + (r.duration_days ?? 0)
        );
      }
    }
    const underUtilised = activeItems
      .filter((i) => (i.acquisition_cost_gbp ?? 0) > 500)
      .map((i) => ({
        name: i.name_canonical,
        acqCost: i.acquisition_cost_gbp ?? 0,
        util: Math.min(
          1,
          (rentalDaysMap.get(i.name_canonical) ?? 0) / UTIL_WINDOW
        ),
      }))
      .filter((i) => i.util < 0.2)
      .sort((a, b) => b.acqCost - a.acqCost)
      .slice(0, 3);

    if (underUtilised.length > 0) {
      const tied = underUtilised.reduce((s, i) => s + i.acqCost, 0);
      const names = underUtilised
        .map((i) => i.name + " (" + Math.round(i.util * 100) + "% util)")
        .join(", ");
      insights.push({
        kind: "under_utilised",
        headline:
          "£" +
          tied.toFixed(0) +
          " tied up in low-utilisation premium items",
        body:
          "Items under 20% utilisation with cost >£500: " +
          names +
          ". Review the Sell Recommender for offload candidates.",
      });
    }

    // Insight 5: Booking stats / portfolio summary
    const bookingCount = last90Res.length;
    if (bookingCount > 0) {
      const totalFromItems = last90Res.reduce(
        (s, r) => s + (r.gross_paid_gbp ?? 0),
        0
      );
      const avgBookingValue = totalFromItems / bookingCount;
      const totalAll = allReservations.reduce(
        (s, r) => s + (r.gross_paid_gbp ?? 0),
        0
      );
      const upsellNote =
        avgBookingValue > 200
          ? "reflects a strong premium mix."
          : "suggests room to upsell bundles or accessories.";
      insights.push({
        kind: "booking_stats",
        headline:
          bookingCount +
          " bookings in last 90 days (avg £" +
          avgBookingValue.toFixed(0) +
          ")",
        body:
          "Total lifetime revenue: £" +
          totalAll.toFixed(0) +
          ". Average booking value of £" +
          avgBookingValue.toFixed(0) +
          " " +
          upsellNote,
      });
    }

    if (insights.length === 0) {
      return [
        {
          kind: "no_data",
          headline: "Not enough data yet",
          body: "Import more reservation history to unlock AI investment insights.",
        },
      ];
    }

    return insights.slice(0, 5);
  },
});
