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

    // Fetch pricing for weighted split (BF wrong-number fix 3)
    const pricingAll = await ctx.db.query("pricing_catalog").collect();
    const priceByName = new Map(pricingAll.map((p) => [p.item_name_canonical, p.daily_price_min]));

    const itemMap = new Map<string, { totalRevenue: number; rentalCount: number; totalDays: number }>();
    for (const r of reservations) {
      const items = r.items ?? [];
      const gross = r.gross_paid_gbp ?? 0;
      if (items.length === 0) continue;

      // Proportional split: each item's share = its daily_price_min / sum of all items' daily_price_min
      const prices = items.map((i) => priceByName.get(i.item_name) ?? 0);
      const priceSum = prices.reduce((s, p) => s + p, 0);

      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        // Fall back to equal split if any price is missing
        const share = priceSum > 0
          ? gross * (prices[idx] / priceSum)
          : gross / items.length;
        const existing = itemMap.get(item.item_name) ?? { totalRevenue: 0, rentalCount: 0, totalDays: 0 };
        existing.totalRevenue += share;
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

    // Include ongoing (start<=today, end>=today) + upcoming (start<=endStr) confirmed reservations
    let reservations = await ctx.db
      .query("reservations")
      .collect();
    reservations = reservations.filter(
      (r) =>
        r.status === "confirmed" &&
        r.start_date !== undefined &&
        r.end_date !== undefined &&
        r.start_date <= endStr &&
        r.end_date >= today
    );
    if (accountSlug) {
      reservations = reservations.filter((r) => r.account_slug === accountSlug);
    }

    // Build hold counts using fuzzy canonical name matching
    // (Hygglo item_name is the full listing title; items table uses short canonical names)
    const allItems = await ctx.db.query("items").collect();
    const activeItems = allItems.filter((i) => i.status === "active" && !i.is_marketing_only);

    // Build a normalized lookup map: simplified key -> canonical name
    function normalize(s: string): string {
      return s.toLowerCase().replace(/[^a-z0-9]/g, "");
    }

    // Match a Hygglo listing title to a canonical item name
    function matchCanonical(listingTitle: string, canonicalNames: string[]): string | null {
      const titleNorm = normalize(listingTitle);
      // Score each canonical name: how many of its tokens appear in the listing title
      let best: string | null = null;
      let bestScore = 0;
      for (const canon of canonicalNames) {
        const canonNorm = normalize(canon);
        // If the canonical name (normalized) appears in the listing title, it is a match
        if (titleNorm.includes(canonNorm) && canonNorm.length > bestScore) {
          best = canon;
          bestScore = canonNorm.length;
        }
      }
      return best;
    }

    const canonicalNames = activeItems.map((i) => i.name_canonical);

    const holdCounts = new Map<string, number>();
    const nextAvailMap = new Map<string, string>();
    for (const r of reservations) {
      for (const item of r.items ?? []) {
        const canon = matchCanonical(item.item_name, canonicalNames);
        if (!canon) continue;
        holdCounts.set(canon, (holdCounts.get(canon) ?? 0) + 1);
        const existing = nextAvailMap.get(canon);
        if (!existing || (r.end_date && r.end_date > existing)) {
          nextAvailMap.set(canon, r.end_date ?? endStr);
        }
      }
    }

    return activeItems
      .filter(
        (i) =>
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
 * W16 Sell Recommender - low utilization items flagged for sale.
 * Groups by name_canonical so multiple units of the same model appear as ONE row
 * (mirrors v1 sell-recommender.service.ts which groups by item_name before scoring).
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

    // Build rental-days per canonical name from reservation items[]
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

    // Group by name_canonical — multiple unit rows collapse to one recommendation
    type GroupEntry = {
      representative_id: string;
      name_canonical: string;
      total_qty: number;
      earliest_created_at: number;
    };
    const groups = new Map<string, GroupEntry>();
    for (const i of allItems) {
      if (i.status !== "active" || i.is_marketing_only) continue;
      const existing = groups.get(i.name_canonical);
      if (!existing) {
        groups.set(i.name_canonical, {
          representative_id: i._id,
          name_canonical: i.name_canonical,
          total_qty: i.qty,
          earliest_created_at: i.created_at,
        });
      } else {
        existing.total_qty += i.qty;
        if (i.created_at < existing.earliest_created_at) {
          existing.earliest_created_at = i.created_at;
        }
      }
    }

    const flagged = await Promise.all(
      Array.from(groups.values()).map(async (g) => {
        const rentalDays = rentalDaysMap.get(g.name_canonical) ?? 0;
        const utilizationPct = rentalDays / LOOKBACK_DAYS;
        const ageMonths =
          (Date.now() - g.earliest_created_at) / (1000 * 60 * 60 * 24 * 30);

        if (utilizationPct > UTIL_THRESHOLD && ageMonths < 24) return null;

        const priceRow = await ctx.db
          .query("pricing_catalog")
          .withIndex("by_name", (q) => q.eq("item_name_canonical", g.name_canonical))
          .first();
        const estResaleValue = priceRow ? priceRow.daily_price_min * 30 : null;
        const reason = utilizationPct <= UTIL_THRESHOLD ? "Low demand" : "High age";

        return {
          itemId: g.representative_id,
          name: g.name_canonical,
          qty: g.total_qty,
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

    const allPricingRows = await ctx.db.query("pricing_catalog").collect();

    // BF-01: deduplicate — one row per name_canonical, keep highest updated_at
    const bestByName = new Map<string, typeof allPricingRows[0]>();
    for (const p of allPricingRows) {
      if (p.is_bundle || p.marketing_only) continue;
      const existing = bestByName.get(p.item_name_canonical);
      if (!existing || p.created_at > existing.created_at) {
        bestByName.set(p.item_name_canonical, p);
      }
    }

    return Array.from(bestByName.values()).map((p) => {
      const bookings = freqMap.get(p.item_name_canonical) ?? 0;
      const currentRate = p.daily_price_min;
      if (bookings >= 3) {
        return {
          itemId: p.item_id,
          name: p.item_name_canonical,
          currentRate,
          suggestedRate: parseFloat((currentRate * 1.15).toFixed(2)),
          pctChange: 15,
          demandSignal: bookings + " bookings this month",
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
    }).filter((r): r is NonNullable<typeof r> => r !== null);
  },
});

/** Simple list of active item names for dropdown selects. */
export const listActive = query({
  args: {},
  handler: async (ctx) => {
    const items = await ctx.db.query("items").collect();
    return items
      .filter((i) => i.status === "active" && !i.is_marketing_only)
      .map((i) => ({ id: i._id, name: i.name_canonical }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
