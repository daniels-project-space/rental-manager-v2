import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * W10 Item Revenue Panel - ranked list by revenue over a period
 */
export const getItemRevenueRanking = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.number(),
  },
  handler: async (ctx, { accountSlug, days }) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }

    const itemMap = new Map<string, { totalRevenue: number; rentalCount: number; totalDays: number }>();
    for (const r of reservations) {
      const grossShare = (r.gross_paid_gbp ?? 0) / Math.max(1, (r.items ?? []).length);
      for (const item of r.items ?? []) {
        const existing = itemMap.get(item.item_name) ?? { totalRevenue: 0, rentalCount: 0, totalDays: 0 };
        existing.totalRevenue += grossShare;
        existing.rentalCount += 1;
        existing.totalDays += r.duration_days ?? 0;
        itemMap.set(item.item_name, existing);
      }
    }

    return Array.from(itemMap.entries())
      .map(([name, stats]) => ({
        name,
        totalRevenue: stats.totalRevenue,
        rentalCount: stats.rentalCount,
        avgValue: stats.rentalCount > 0 ? stats.totalRevenue / stats.rentalCount : 0,
        totalDays: stats.totalDays,
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);
  },
});

/**
 * W12 Item Cycle Tracker - utilization per item over a period
 */
export const getItemCycles = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.number(),
  },
  handler: async (ctx, { accountSlug, days }) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }

    const rentalDaysMap = new Map<string, number>();
    for (const r of reservations) {
      for (const item of r.items ?? []) {
        rentalDaysMap.set(
          item.item_name,
          (rentalDaysMap.get(item.item_name) ?? 0) + (r.duration_days ?? 0)
        );
      }
    }

    const allItems = await ctx.db.query("items").collect();
    return allItems
      .filter((i) => i.status === "active" && !i.is_marketing_only)
      .map((item) => {
        const rentalDays = rentalDaysMap.get(item.name_canonical) ?? 0;
        return {
          itemId: item._id,
          name: item.name_canonical,
          rentalDays,
          idleDays: Math.max(0, days - rentalDays),
          unavailDays: 0,
          utilizationPct: days > 0 ? rentalDays / days : 0,
        };
      });
  },
});

/**
 * W13 Out-of-Stock Panel - items fully booked within look-ahead window
 */
export const getOutOfStockItems = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    lookAheadDays: v.number(),
  },
  handler: async (ctx, { accountSlug, lookAheadDays }) => {
    const today = new Date().toISOString().slice(0, 10);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + lookAheadDays);
    const endStr = endDate.toISOString().slice(0, 10);

    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", today))
      .collect();
    reservations = reservations.filter(
      (r) =>
        r.start_date !== undefined &&
        r.start_date <= endStr &&
        r.status === "confirmed"
    );
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }

    const holdCounts = new Map<string, number>();
    const nextAvailMap = new Map<string, string>();
    for (const r of reservations) {
      for (const item of r.items ?? []) {
        holdCounts.set(item.item_name, (holdCounts.get(item.item_name) ?? 0) + 1);
        const existing = nextAvailMap.get(item.item_name);
        if (!existing || (r.end_date && r.end_date > existing)) {
          nextAvailMap.set(item.item_name, r.end_date ?? endStr);
        }
      }
    }

    const allItems = await ctx.db.query("items").collect();
    return allItems
      .filter(
        (i) =>
          i.status === "active" &&
          !i.is_marketing_only &&
          holdCounts.has(i.name_canonical) &&
          (holdCounts.get(i.name_canonical) ?? 0) >= i.qty
      )
      .map((i) => ({
        itemId: i._id,
        name: i.name_canonical,
        nextAvailableDate: nextAvailMap.get(i.name_canonical) ?? null,
        activeReservationCount: holdCounts.get(i.name_canonical) ?? 0,
      }));
  },
});

/**
 * W16 Sell Recommender - low utilization items flagged for sale
 */
export const getSellRecommendations = query({
  args: { accountSlug: v.union(v.string(), v.null()) },
  handler: async (ctx, { accountSlug }) => {
    const LOOKBACK_DAYS = 90;
    const UTIL_THRESHOLD = 0.25;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }

    const rentalDaysMap = new Map<string, number>();
    for (const r of reservations) {
      for (const item of r.items ?? []) {
        rentalDaysMap.set(
          item.item_name,
          (rentalDaysMap.get(item.item_name) ?? 0) + (r.duration_days ?? 0)
        );
      }
    }

    const allItems = await ctx.db.query("items").collect();
    const flagged = await Promise.all(
      allItems
        .filter((i) => i.status === "active" && !i.is_marketing_only)
        .map(async (i) => {
          const rentalDays = rentalDaysMap.get(i.name_canonical) ?? 0;
          const utilizationPct = rentalDays / LOOKBACK_DAYS;
          const ageMonths = (Date.now() - i.created_at) / (1000 * 60 * 60 * 24 * 30);

          if (utilizationPct > UTIL_THRESHOLD && ageMonths < 24) return null;

          const priceRow = await ctx.db
            .query("pricing_catalog")
            .withIndex("by_name", (q) => q.eq("item_name_canonical", i.name_canonical))
            .first();
          const estResaleValue = priceRow ? priceRow.daily_price_min * 30 : null;
          const reason = utilizationPct <= UTIL_THRESHOLD ? "Low demand" : "High age";

          return {
            itemId: i._id,
            name: i.name_canonical,
            utilizationPct,
            ageMonths,
            estResaleValue,
            reason,
          };
        })
    );

    return flagged.filter((r) => r !== null);
  },
});

/**
 * W17 Price Recommendations - demand-signal based price suggestions
 */
export const getPriceRecommendations = query({
  args: { accountSlug: v.union(v.string(), v.null()) },
  handler: async (ctx, { accountSlug }) => {
    const LOOKBACK_DAYS = 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }

    const freqMap = new Map<string, number>();
    for (const r of reservations) {
      for (const item of r.items ?? []) {
        freqMap.set(item.item_name, (freqMap.get(item.item_name) ?? 0) + 1);
      }
    }

    const pricingRows = await ctx.db.query("pricing_catalog").collect();
    return pricingRows
      .filter((p) => !p.is_bundle && !p.marketing_only)
      .map((p) => {
        const bookings = freqMap.get(p.item_name_canonical) ?? 0;
        const currentRate = p.daily_price_min;
        if (bookings >= 3) {
          return {
            itemId: p.item_id,
            name: p.item_name_canonical,
            currentRate,
            suggestedRate: parseFloat((currentRate * 1.15).toFixed(2)),
            pctChange: 15,
            demandSignal: `${bookings} bookings this month`,
          };
        } else if (bookings <= 1) {
          return {
            itemId: p.item_id,
            name: p.item_name_canonical,
            currentRate,
            suggestedRate: parseFloat((currentRate * 0.9).toFixed(2)),
            pctChange: -10,
            demandSignal: bookings === 0 ? "No bookings this month" : "Low demand",
          };
        }
        return null;
      })
      .filter((r) => r !== null);
  },
});
