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
      // BF-06: use pickup_date if available, fall back to start_date
      const dateStr = r.pickup_date ?? r.start_date;
      if (!dateStr) continue;
      let key: string;
      if (granularity === "monthly") {
        key = dateStr.slice(0, 7); // YYYY-MM
      } else {
        // ISO 8601 week: use proper ISO week number (not naive day-of-year / 7)
        const d = new Date(dateStr);
        // ISO week: Monday-based, week 1 = week containing first Thursday
        const dayOfWeek = (d.getDay() + 6) % 7; // Mon=0 .. Sun=6
        const thursday = new Date(d);
        thursday.setDate(d.getDate() - dayOfWeek + 3);
        const jan1 = new Date(thursday.getFullYear(), 0, 1);
        const weekNum = 1 + Math.round((thursday.getTime() - jan1.getTime()) / 604800000);
        key = thursday.getFullYear() + "-W" + String(weekNum).padStart(2, "0");
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
    // Only count active non-marketing items WITH known acquisition cost (null items excluded, not treated as 0)
    const itemsWithCost = allItems.filter(
      (i) => !i.is_marketing_only && i.status !== "inactive" && i.status !== "archived" &&
             i.acquisition_cost_gbp != null && i.acquisition_cost_gbp > 0
    );
    const totalInvested = itemsWithCost.reduce((sum, i) => sum + (i.acquisition_cost_gbp ?? 0), 0);
    const itemsWithCostCount = itemsWithCost.length;
    const itemsMissingCostCount = allItems.filter(
      (i) => !i.is_marketing_only && i.status === "active" && (i.acquisition_cost_gbp == null || i.acquisition_cost_gbp === 0)
    ).length;

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
      itemsWithCostCount,
      itemsMissingCostCount,
    };
  },
});

/**
 * W03 Lifetime Revenue Chart — monthly stacked bars + cumulative line
 * Returns every month from first reservation to today (inclusive), with zeros for empty months.
 * accountSlug: null = all accounts combined
 */

/**
 * W03 Lifetime Revenue Chart — full series: organic per account, AI Boost,
 * damage/claims, booked-next, pending-next, cumulative line, forecast.
 * Returns months from first reservation through current+3 (forecast tail).
 * accountSlug: null = all accounts combined
 */
export const getLifetimeByMonth = query({
  args: { accountSlug: v.union(v.string(), v.null()) },
  handler: async (ctx, { accountSlug }) => {
    const AI_ACTIVE_FROM = "2026-02";
    // boostRate from settings.ai_boost_rate if present, else 0
    const settings = await ctx.db.query("settings").first();
    const boostRate: number =
      settings && "ai_boost_rate" in settings
        ? (settings as unknown as Record<string, number>).ai_boost_rate
        : 0;

    const allReservations = await ctx.db.query("reservations").collect();

    const allDates = allReservations
      .filter((r) => r.start_date)
      .map((r) => r.start_date as string)
      .sort();
    if (allDates.length === 0) {
      return {
        months: [],
        totalRevenue: 0,
        avgMonthly: 0,
        strongestMonth: null,
        weakestMonth: null,
        boostRate,
        aiActiveFrom: AI_ACTIVE_FROM,
        forecast: [],
      };
    }

    const firstMonth = allDates[0].slice(0, 7);
    const now = new Date();
    const currentMonth = now.toISOString().slice(0, 7);
    const forecastEnd = new Date(now.getFullYear(), now.getMonth() + 4, 1);

    const monthKeys: string[] = [];
    {
      const c = new Date(firstMonth + "-01");
      while (c < forecastEnd) {
        monthKeys.push(c.toISOString().slice(0, 7));
        c.setMonth(c.getMonth() + 1);
      }
    }

    const filtered = accountSlug
      ? allReservations.filter((r) => r.account_slug === accountSlug)
      : allReservations;

    // Insurance claims grouped by month
    const allClaims = await ctx.db.query("insurance_claims").collect();
    const claimsByMonth = new Map<string, number>();
    for (const c of allClaims) {
      if (accountSlug && c.account_slug !== accountSlug) continue;
      const m = c.claim_date.slice(0, 7);
      claimsByMonth.set(m, r2((claimsByMonth.get(m) ?? 0) + c.amount_gbp));
    }

    const nextMonthKey = new Date(now.getFullYear(), now.getMonth() + 1, 1)
      .toISOString()
      .slice(0, 7);

    const dbGross = new Map<string, number>();
    const leoGross = new Map<string, number>();
    let bookedNextTotal = 0;
    let pendingNextTotal = 0;

    for (const res of filtered) {
      const dateStr = res.pickup_date ?? res.start_date;
      if (!dateStr) continue;
      const gross = res.gross_paid_gbp ?? 0;
      const slug = res.account_slug ?? "dbcinema";
      const isFutureRes = dateStr.slice(0, 7) > currentMonth;

      if (isFutureRes) {
        const futureMo = (res.start_date ?? dateStr).slice(0, 7);
        if (futureMo === nextMonthKey) {
          if (res.status === "confirmed") bookedNextTotal = r2(bookedNextTotal + gross);
          else if (res.status === "pending_review" || res.status === "pending")
            pendingNextTotal = r2(pendingNextTotal + gross);
        }
        continue;
      }

      const key = dateStr.slice(0, 7);
      if (slug === "leo") {
        leoGross.set(key, r2((leoGross.get(key) ?? 0) + gross));
      } else {
        dbGross.set(key, r2((dbGross.get(key) ?? 0) + gross));
      }
    }

    const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    type MonthRow = {
      month: string;
      monthLabel: string;
      dbcinemaOrganic: number;
      leoOrganic: number;
      danielRetired: number;
      vertusRetired: number;
      aiBoost: number;
      damageClaims: number;
      bookedNext: number;
      pendingNext: number;
      cumulative: number;
      count: number;
    };

    const rows: MonthRow[] = [];
    let cumulative = 0;

    for (const mo of monthKeys) {
      const [yr, mIdx] = mo.split("-").map(Number);
      const label = MONTH_NAMES[mIdx - 1] + " " + String(yr).slice(2);
      const isFuture = mo > currentMonth;
      const isNextMo = mo === nextMonthKey;

      let dbOrganic = 0;
      let leoOrganic = 0;
      let aiBoost = 0;
      let damageClaims = 0;
      let bookedNextVal = 0;
      let pendingNextVal = 0;

      if (!isFuture) {
        const dbRaw = dbGross.get(mo) ?? 0;
        const leoRaw = leoGross.get(mo) ?? 0;
        const totalRaw = dbRaw + leoRaw;
        if (mo >= AI_ACTIVE_FROM && boostRate > 0 && totalRaw > 0) {
          aiBoost = r2(totalRaw * boostRate / (1 + boostRate));
          const dbFrac = dbRaw / totalRaw;
          dbOrganic = r2(dbRaw - aiBoost * dbFrac);
          leoOrganic = r2(leoRaw - aiBoost * (1 - dbFrac));
        } else {
          dbOrganic = dbRaw;
          leoOrganic = leoRaw;
        }
        damageClaims = claimsByMonth.get(mo) ?? 0;
      } else if (isNextMo) {
        bookedNextVal = bookedNextTotal;
        pendingNextVal = pendingNextTotal;
      }

      const monthTotal = dbOrganic + leoOrganic + aiBoost + damageClaims + bookedNextVal + pendingNextVal;
      cumulative = r2(cumulative + monthTotal);

      const count = !isFuture
        ? filtered.filter((r) => {
            const d = r.pickup_date ?? r.start_date;
            return d && d.slice(0, 7) === mo && (r.gross_paid_gbp ?? 0) > 0;
          }).length
        : 0;

      rows.push({
        month: mo,
        monthLabel: label,
        dbcinemaOrganic: dbOrganic,
        leoOrganic,
        danielRetired: 0,
        vertusRetired: 0,
        aiBoost,
        damageClaims,
        bookedNext: bookedNextVal,
        pendingNext: pendingNextVal,
        cumulative,
        count,
      });
    }

    const completedRows = rows.filter(
      (row) =>
        row.month < currentMonth &&
        row.dbcinemaOrganic + row.leoOrganic + row.aiBoost + row.damageClaims > 0
    );

    const monthRev = (row: MonthRow) =>
      row.dbcinemaOrganic + row.leoOrganic + row.aiBoost + row.damageClaims;

    const totalRevenue = r2(completedRows.reduce((s, row) => s + monthRev(row), 0));
    const avgMonthly =
      completedRows.length > 0 ? Math.round(totalRevenue / completedRows.length) : 0;

    const strongestMonth =
      completedRows.length > 0
        ? completedRows.reduce((best, row) => (monthRev(row) > monthRev(best) ? row : best))
        : null;
    const weakestMonth =
      completedRows.length > 0
        ? completedRows.reduce((worst, row) => (monthRev(row) < monthRev(worst) ? row : worst))
        : null;

    // Forecast: weighted 3-month moving average → project next 3 months
    const recent3 = completedRows.slice(-3);
    let forecastBase = avgMonthly;
    if (recent3.length === 3) {
      forecastBase = Math.round(
        monthRev(recent3[2]) * 0.5 + monthRev(recent3[1]) * 0.3 + monthRev(recent3[0]) * 0.2
      );
    } else if (recent3.length === 2) {
      forecastBase = Math.round(monthRev(recent3[1]) * 0.6 + monthRev(recent3[0]) * 0.4);
    } else if (recent3.length === 1) {
      forecastBase = Math.round(monthRev(recent3[0]));
    }

    const forecast: Array<{ month: string; value: number }> = [];
    for (let i = 1; i <= 3; i++) {
      const fd = new Date(now.getFullYear(), now.getMonth() + i, 1);
      forecast.push({ month: fd.toISOString().slice(0, 7), value: forecastBase });
    }

    return {
      months: rows,
      totalRevenue,
      avgMonthly,
      strongestMonth: strongestMonth
        ? { month: strongestMonth.month, revenue: r2(monthRev(strongestMonth)) }
        : null,
      weakestMonth: weakestMonth
        ? { month: weakestMonth.month, revenue: r2(monthRev(weakestMonth)) }
        : null,
      boostRate,
      aiActiveFrom: AI_ACTIVE_FROM,
      forecast,
    };
  },
});

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
