import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * W04 Earnings Chart — revenue grouped by month or week
 * granularity: "monthly" | "weekly"
 * months: how many months back to include
 */
export const getEarningsByPeriod = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    granularity: v.union(v.literal("monthly"), v.literal("weekly")),
    months: v.number(),
  },
  handler: async (ctx, { accountSlug, granularity, months }) => {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // Use by_start_date index for efficient range scan
    let rows = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    if (accountSlug) {
      rows = rows.filter((r) => r.account_slug === accountSlug);
    }

    const buckets = new Map<string, { revenue: number; bookings: number }>();

    for (const r of rows) {
      if (!r.start_date) continue;
      let key: string;
      if (granularity === "monthly") {
        key = r.start_date.slice(0, 7); // YYYY-MM
      } else {
        // ISO week: YYYY-WNN
        const d = new Date(r.start_date);
        const jan1 = new Date(d.getFullYear(), 0, 1);
        const weekNum = Math.ceil(
          ((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7
        );
        key = `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
      }
      const existing = buckets.get(key) ?? { revenue: 0, bookings: 0 };
      existing.revenue += r.gross_paid_gbp ?? 0;
      existing.bookings += 1;
      buckets.set(key, existing);
    }

    return Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, { revenue, bookings }]) => ({
        period,
        revenue,
        bookings,
      }));
  },
});

/**
 * W14 Missed Revenue — denial losses + pricing_catalog estimated gap
 */
export const getMissedRevenue = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.number(),
  },
  handler: async (ctx, { accountSlug, days }) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    let denials = await ctx.db.query("denial_records").collect();
    if (accountSlug) {
      const accountRow = await ctx.db
        .query("accounts")
        .withIndex("by_slug", (q) => q.eq("slug", accountSlug as string))
        .first();
      if (accountRow) {
        denials = denials.filter((d) => d.account_id === accountRow._id);
      }
    }
    denials = denials.filter((d) => d.created_at >= cutoff.getTime());

    // Compute estimated value per denial via pricing_catalog daily rate
    const denialLosses = await Promise.all(
      denials.map(async (d) => {
        let estimatedValue = 0;
        if (d.item_name) {
          const priceRow = await ctx.db
            .query("pricing_catalog")
            .withIndex("by_name", (q) =>
              q.eq("item_name_canonical", d.item_name as string)
            )
            .first();
          if (priceRow) {
            // Assume a 2-day average rental
            estimatedValue = priceRow.daily_price_min * 2;
          }
        }
        return {
          denialId: d._id,
          reason: d.reason,
          itemName: d.item_name,
          estimatedValue,
          notes: d.notes,
          createdAt: d.created_at,
        };
      })
    );

    const denialTotal = denialLosses.reduce(
      (sum, d) => sum + d.estimatedValue,
      0
    );

    // ── Idle-gap losses ──────────────────────────────────────────
    // For each active item that had ANY rental in the lookback window,
    // estimate idle days = (days - actual_rental_days) × daily_price_min.
    // This gives an upper-bound on opportunity cost from un-rented inventory.
    // Conservative: items with zero bookings in the period are excluded
    // (no demand signal → gap is not reliably a loss).
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    let allResForGap = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    if (accountSlug) {
      allResForGap = allResForGap.filter((r) => r.account_slug === accountSlug);
    }

    // Accumulate rental days per item name across the window
    const rentalDaysPerItem = new Map<string, number>();
    for (const r of allResForGap) {
      for (const item of r.items ?? []) {
        rentalDaysPerItem.set(
          item.item_name,
          (rentalDaysPerItem.get(item.item_name) ?? 0) + (r.duration_days ?? 0)
        );
      }
    }

    // Only items that actually had at least one booking in the window
    const gapLosses: Array<{ itemName: string; rentalDays: number; idleDays: number; estimatedGapLoss: number }> = [];
    const pricingRows = await ctx.db.query("pricing_catalog").collect();
    const priceByName = new Map(pricingRows.map((p) => [p.item_name_canonical, p.daily_price_min]));

    for (const [itemName, rentalDays] of rentalDaysPerItem.entries()) {
      const idleDays = Math.max(0, days - Math.min(rentalDays, days));
      if (idleDays <= 0) continue;
      const dailyRate = priceByName.get(itemName);
      if (!dailyRate) continue;
      gapLosses.push({
        itemName,
        rentalDays,
        idleDays,
        estimatedGapLoss: parseFloat((idleDays * dailyRate).toFixed(2)),
      });
    }
    gapLosses.sort((a, b) => b.estimatedGapLoss - a.estimatedGapLoss);

    const gapTotal = gapLosses.reduce((s, g) => s + g.estimatedGapLoss, 0);
    const totalMissed = denialTotal + gapTotal;

    return {
      totalMissed,
      denialLosses,
      gapLosses,
      gapTotal: parseFloat(gapTotal.toFixed(2)),
      denialTotal: parseFloat(denialTotal.toFixed(2)),
    };
  },
});

/**
 * W15 Investment Scorecard — ROI using items.acquisition_cost_gbp
 */
export const getInvestmentScorecard = query({
  args: { accountSlug: v.union(v.string(), v.null()) },
  handler: async (ctx, { accountSlug }) => {
    const allItems = await ctx.db.query("items").collect();
    // Only count active non-marketing items in total investment (mirrors v1 acquisition-costs scope)
    const totalInvested = allItems
      .filter((i) => !i.is_marketing_only && i.status !== "inactive" && i.status !== "archived")
      .reduce((sum, i) => sum + (i.acquisition_cost_gbp ?? 0), 0);

    let reservations = await ctx.db.query("reservations").collect();
    if (accountSlug) {
      reservations = reservations.filter(
        (r) => r.account_slug === accountSlug
      );
    }
    const totalRevenue = reservations.reduce(
      (sum, r) => sum + (r.gross_paid_gbp ?? 0),
      0
    );

    const netProfit = totalRevenue - totalInvested;
    const roiPct =
      totalInvested > 0 ? (netProfit / totalInvested) * 100 : 0;

    // Monthly rate from earliest reservation
    const sortedDates = reservations
      .filter((r) => r.start_date)
      .map((r) => r.start_date as string)
      .sort();
    const earliestDate =
      sortedDates.length > 0 ? new Date(sortedDates[0]) : new Date();
    const monthsElapsed = Math.max(
      1,
      (Date.now() - earliestDate.getTime()) / (1000 * 60 * 60 * 24 * 30)
    );
    const monthlyRate = totalRevenue / monthsElapsed;
    const paybackMonths =
      monthlyRate > 0 ? totalInvested / monthlyRate : Infinity;

    return {
      totalInvested,
      totalRevenue,
      netProfit,
      roiPct,
      paybackMonths: isFinite(paybackMonths) ? paybackMonths : null,
      monthlyRate,
    };
  },
});

/**
 * W03 Lifetime Revenue Chart — monthly stacked bars + cumulative line
 * Returns every month from first reservation to today (inclusive), with zeros for empty months.
 * accountSlug: null = all accounts combined
 */
export const getLifetimeByMonth = query({
  args: { accountSlug: v.union(v.string(), v.null()) },
  handler: async (ctx, { accountSlug }) => {
    let reservations = await ctx.db.query('reservations').collect();

    // Find earliest start_date across ALL accounts for x-axis span
    const allDates = reservations
      .filter((r) => r.start_date)
      .map((r) => r.start_date as string)
      .sort();
    if (allDates.length === 0) return [];

    const firstMonth = allDates[0].slice(0, 7); // YYYY-MM
    const todayMonth = new Date().toISOString().slice(0, 7);

    // Generate all YYYY-MM keys from firstMonth to todayMonth
    const months: string[] = [];
    let cur = new Date(firstMonth + '-01');
    const endDate = new Date(todayMonth + '-01');
    while (cur <= endDate) {
      months.push(cur.toISOString().slice(0, 7));
      cur.setMonth(cur.getMonth() + 1);
    }

    // Filter reservations by account if needed
    const filtered = accountSlug
      ? reservations.filter((r) => r.account_slug === accountSlug)
      : reservations;

    // Bucket per-account monthly gross
    const dbMap = new Map<string, number>();
    const leoMap = new Map<string, number>();

    for (const r of filtered) {
      if (!r.start_date) continue;
      const key = r.start_date.slice(0, 7);
      const gross = r.gross_paid_gbp ?? 0;
      if (r.account_slug === 'dbcinema') {
        dbMap.set(key, (dbMap.get(key) ?? 0) + gross);
      } else if (r.account_slug === 'leo') {
        leoMap.set(key, (leoMap.get(key) ?? 0) + gross);
      }
    }

    // Build output with running cumulative
    let cumulative = 0;
    return months.map((month) => {
      const dbcinema = parseFloat((dbMap.get(month) ?? 0).toFixed(2));
      const leo = parseFloat((leoMap.get(month) ?? 0).toFixed(2));
      cumulative += dbcinema + leo;
      return {
        month,
        dbcinema,
        leo,
        cumulative: parseFloat(cumulative.toFixed(2)),
      };
    });
  },
});
