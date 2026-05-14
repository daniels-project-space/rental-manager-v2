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
    const now = new Date();
    const currentMonth = now.toISOString().slice(0, 7);
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
    // Exclude cancelled/unconfirmed reservations (v1 parity: only confirmed/completed)
    rows = rows.filter((r) => r.status !== "cancelled" && r.status !== "denied");

    const buckets = new Map<string, { revenue: number; bookings: number }>();

    for (const r of rows) {
      // BF-06: use pickup_date if available, fall back to start_date
      const dateStr = r.pickup_date ?? r.start_date;
      if (!dateStr) continue;
      // Cap to current month — don't show future months in the earnings chart
      const effectiveMo = dateStr.slice(0, 7);
      if (effectiveMo > currentMonth) continue;
      let key: string;
      if (granularity === "monthly") {
        key = effectiveMo;
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
        // Use stored estimated_value (backfilled from v1) first; fallback to pricing_catalog.
        let estimatedValue = d.estimated_value ?? 0;
        if (estimatedValue === 0 && d.item_name) {
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
    // AI Boost parameters from settings (no hardcoded fallback — settings row is seeded)
    const settings = await ctx.db.query("settings").first();
    const AI_ACTIVE_FROM: string = (settings as unknown as Record<string, string>)?.ai_active_from ?? "2026-02";
    const boostRate: number = (settings as unknown as Record<string, number>)?.ai_boost_rate ?? 0.24;

    const allReservations = await ctx.db.query("reservations").collect();

    // Load historical_revenue for pre-import months (retired accounts + v1 migration)
    const histRows = await ctx.db.query("historical_revenue").collect();
    const histByMonth = new Map<string, {
      total: number; damage: number; totalOverallMade: number;
      dbcinema?: number; leo?: number; daniel?: number; vertus?: number;
    }>();
    for (const row of histRows) {
      histByMonth.set(row.month, {
        total: row.total_revenue_gbp,
        damage: row.damage_costs_gbp,
        totalOverallMade: row.total_overall_made_gbp ?? 0,
        dbcinema: (row as unknown as Record<string, number>).dbcinema_revenue_gbp,
        leo: (row as unknown as Record<string, number>).leo_revenue_gbp,
        daniel: (row as unknown as Record<string, number>).daniel_revenue_gbp,
        vertus: (row as unknown as Record<string, number>).vertus_revenue_gbp,
      });
    }

    const allDates = allReservations
      .filter((r) => r.start_date)
      .map((r) => r.start_date as string)
      .sort();

    // Determine the earliest month across live reservations AND historical data
    const histMonths = [...histByMonth.keys()].sort();
    const firstHistMonth = histMonths[0] ?? null;
    const firstResMonth = allDates.length > 0 ? allDates[0].slice(0, 7) : null;

    const firstMonth =
      firstResMonth && firstHistMonth
        ? firstResMonth < firstHistMonth ? firstResMonth : firstHistMonth
        : firstResMonth ?? firstHistMonth;

    if (!firstMonth) {
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

    // Historical damage costs — overlay onto claimsByMonth if no tracked claim exists.
    if (!accountSlug) {
      for (const [month, hist] of histByMonth) {
        if (hist.damage > 0 && !claimsByMonth.has(month)) {
          claimsByMonth.set(month, hist.damage);
        }
      }
    }

    const nextMonthKey = new Date(now.getFullYear(), now.getMonth() + 1, 1)
      .toISOString()
      .slice(0, 7);

    const dbGross = new Map<string, number>();
    const leoGross = new Map<string, number>();
    let bookedNextTotal = 0;
    let pendingNextTotal = 0;

    // Dedup by Hygglo order id (the real unique key) — collapsing on
    // renter+dates was dropping legitimate separate orders.
    const seenOrderIds = new Set<string>();
    const dedupedFiltered = filtered.filter((r) => {
      const id = r.hygglo_order_id ?? r.v1_rental_id;
      if (!id) return true; // no stable id → keep
      if (seenOrderIds.has(id)) return false;
      seenOrderIds.add(id);
      return true;
    });

    for (const res of dedupedFiltered) {
      const dateStr = res.pickup_date ?? res.start_date;
      if (!dateStr) continue;
      if (res.is_obsolete) continue;
      if (res.status === "cancelled" || res.status === "declined") continue;
      // Past/current-month bars represent realised revenue — only count
      // confirmed (FUNDS_RESERVED+ per the source-filter rule) or completed.
      // Pending_review (APPROVED / unverified) is shown ONLY in the next-month
      // "Pending" overlay, never as historical revenue.
      const isPending = res.status === "pending_review" || res.status === "pending";
      const amount = res.net_to_owner_gbp ?? 0;
      const slug = res.account_slug ?? "dbcinema";
      const isFutureRes = dateStr.slice(0, 7) > currentMonth;

      if (isFutureRes) {
        const futureMo = (res.start_date ?? dateStr).slice(0, 7);
        if (futureMo === nextMonthKey) {
          if (!isPending) bookedNextTotal = r2(bookedNextTotal + amount);
          else pendingNextTotal = r2(pendingNextTotal + amount);
        }
        continue;
      }

      // Past + current month: exclude pending — it isn't paid revenue.
      if (isPending) continue;

      const key = dateStr.slice(0, 7);
      if (slug === "leo") {
        leoGross.set(key, r2((leoGross.get(key) ?? 0) + amount));
      } else {
        dbGross.set(key, r2((dbGross.get(key) ?? 0) + amount));
      }
    }

    const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    type MonthRow = {
      month: string;
      monthLabel: string;
      dbcinemaOrganic: number;
      leoOrganic: number;
      danielOrganic: number;
      vertusOrganic: number;
      aiBoost: number;
      damageClaims: number;
      bookedNext: number;
      pendingNext: number;
      cumulative: number;
      count: number;
      // v1-parity response shape
      revenue: number;
      byAccount: { dbcinema: number; leo: number; daniel: number; vertus: number };
      damage: number;
      aiAttribution: number;
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
      let danielOrganic = 0;
      let vertusOrganic = 0;
      let aiBoost = 0;
      let damageClaims = 0;
      let bookedNextVal = 0;
      let pendingNextVal = 0;

      if (!isFuture) {
        const dbRaw = dbGross.get(mo) ?? 0;
        const leoRaw = leoGross.get(mo) ?? 0;
        const totalRaw = dbRaw + leoRaw;
        const hist = histByMonth.get(mo);

        // Determine whether per-account hist columns are present for this month.
        // These columns surface regardless of totalOverallMade (fixes gate bug for 2024-08+ leo).
        const hasPerAccountHist = hist &&
          (hist.dbcinema !== undefined || hist.leo !== undefined ||
           hist.daniel !== undefined || hist.vertus !== undefined);

        if (!accountSlug && hist && hist.totalOverallMade > 0) {
          // v1 pre-tracking window (2022-08→2024-07): totalOverallMade is the definitive total.
          // Use stored per-account splits when available (populated by extended backfill script).
          // Fall back to v1's subtraction formula if splits not yet written.
          damageClaims = hist.damage;
          if (hasPerAccountHist) {
            // Per-account splits already computed + stored by backfill script
            dbOrganic = hist.dbcinema ?? 0;
            leoOrganic = hist.leo ?? 0;
            danielOrganic = hist.daniel ?? 0;
            vertusOrganic = hist.vertus ?? 0;
          } else {
            // Legacy fallback: v1's ratio-cap + 50/50 split on remainder
            const netRental = hist.totalOverallMade - hist.damage;
            const totalTracked = dbRaw + leoRaw;
            let cappedDb = dbRaw;
            let cappedLeo = leoRaw;
            if (totalTracked > netRental && totalTracked > 0) {
              const ratio = netRental / totalTracked;
              cappedDb = r2(dbRaw * ratio);
              cappedLeo = r2(leoRaw * ratio);
            }
            const cappedTracked = cappedDb + cappedLeo;
            const remainder = Math.max(0, netRental - cappedTracked);
            dbOrganic = cappedDb;
            leoOrganic = cappedLeo;
            danielOrganic = r2(remainder / 2);
            vertusOrganic = r2(remainder - danielOrganic);
          }
        } else if (!accountSlug && hasPerAccountHist) {
          // Per-account hist columns present (e.g. 2024-08+ leo activity, or zero-live months).
          // Stored values take precedence; live gross is fallback for any absent column.
          dbOrganic = hist!.dbcinema !== undefined ? hist!.dbcinema : dbRaw;
          leoOrganic = hist!.leo !== undefined ? hist!.leo : leoRaw;
          danielOrganic = hist!.daniel !== undefined ? hist!.daniel : 0;
          vertusOrganic = hist!.vertus !== undefined ? hist!.vertus : 0;
          damageClaims = hist!.damage > 0 ? hist!.damage : (claimsByMonth.get(mo) ?? 0);
          aiBoost = 0; // already baked into hist splits
        } else if (!accountSlug && totalRaw === 0 && hist && hist.total > 0) {
          // No live reservations and no per-account splits — use historical aggregate.
          dbOrganic = hist.total;
          damageClaims = claimsByMonth.get(mo) ?? 0;
        } else {
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
        }

        // Per-account filter: zero out accounts not requested.
        // For retired accounts (daniel/vertus), also pull in hist columns that live polling skips.
        if (accountSlug === "dbcinema") {
          // Always incorporate hist.dbcinema so pre-import months surface in the dbcinema-only view.
          dbOrganic = (hist?.dbcinema !== undefined ? hist.dbcinema : 0) + dbRaw;
          leoOrganic = 0; danielOrganic = 0; vertusOrganic = 0; damageClaims = 0;
        } else if (accountSlug === "leo") {
          // Always incorporate hist.leo so pre-import months surface in the leo-only view.
          leoOrganic = (hist?.leo !== undefined ? hist.leo : 0) + leoRaw;
          dbOrganic = 0; danielOrganic = 0; vertusOrganic = 0; damageClaims = 0;
        } else if (accountSlug === "daniel") {
          const histDaniel = hist?.daniel !== undefined ? hist.daniel : 0;
          dbOrganic = histDaniel; // surface hist column; live polling is retired
          leoOrganic = 0; danielOrganic = 0; vertusOrganic = 0; damageClaims = 0;
        } else if (accountSlug === "vertus") {
          const histVertus = hist?.vertus !== undefined ? hist.vertus : 0;
          dbOrganic = histVertus; // surface hist column; live polling is retired
          leoOrganic = 0; danielOrganic = 0; vertusOrganic = 0; damageClaims = 0;
        }
      } else if (isNextMo) {
        bookedNextVal = bookedNextTotal;
        pendingNextVal = pendingNextTotal;
      }

      const monthTotal = dbOrganic + leoOrganic + danielOrganic + vertusOrganic + aiBoost + damageClaims + bookedNextVal + pendingNextVal;
      cumulative = r2(cumulative + monthTotal);

      const count = !isFuture
        ? dedupedFiltered.filter((r) => {
            const d = r.pickup_date ?? r.start_date;
            if (!d || d.slice(0, 7) !== mo) return false;
            if (r.is_obsolete) return false;
            if (r.status === "cancelled" || r.status === "declined") return false;
            if (r.status === "pending_review" || r.status === "pending") return false;
            return (r.gross_paid_gbp ?? 0) > 0 || (r.net_to_owner_gbp ?? 0) > 0;
          }).length
        : 0;

      rows.push({
        month: mo,
        monthLabel: label,
        dbcinemaOrganic: dbOrganic,
        leoOrganic,
        danielOrganic,
        vertusOrganic,
        aiBoost,
        damageClaims,
        bookedNext: bookedNextVal,
        pendingNext: pendingNextVal,
        cumulative,
        count,
        // v1-parity response shape
        revenue: monthTotal,
        byAccount: {
          dbcinema: accountSlug === "daniel" || accountSlug === "vertus" ? 0 : dbOrganic,
          leo: leoOrganic,
          daniel: danielOrganic,
          vertus: vertusOrganic,
        },
        damage: damageClaims,
        aiAttribution: aiBoost,
      });
    }

    const completedRows = rows.filter(
      (row) =>
        // For all-accounts view: exclude current month (in-progress, incomplete aggregate).
        // For per-account view: include current month so confirmed bookings count toward lifetime total.
        (accountSlug ? row.month <= currentMonth : row.month < currentMonth) &&
        row.dbcinemaOrganic + row.leoOrganic + row.danielOrganic + row.vertusOrganic + row.aiBoost + row.damageClaims > 0
    );

    const monthRev = (row: MonthRow) =>
      row.dbcinemaOrganic + row.leoOrganic + row.danielOrganic + row.vertusOrganic + row.aiBoost + row.damageClaims;

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

    // ============================================================
    // Smart forecast: blend month-to-date pace + seasonality (same
    // month in prior years) + recent 3-month moving average.
    // Current month is INCLUDED in the forecast array so the client
    // can render an expected-ceiling marker on top of in-progress bars.
    // ============================================================

    // Lookup of historical revenue by month for seasonality scans.
    const revByMonth = new Map<string, number>();
    for (const r of rows) revByMonth.set(r.month, monthRev(r));

    // Current-month month-to-date pace (extrapolate to full month).
    const daysInCurrentMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const currentRow = rows.find((r) => r.month === currentMonth);
    const currentMonthSoFar = currentRow ? monthRev(currentRow) : 0;
    const paceProjection =
      dayOfMonth > 0
        ? Math.round((currentMonthSoFar / dayOfMonth) * daysInCurrentMonth)
        : currentMonthSoFar;

    // Same month in up to 3 prior years; year-over-year growth factor applied
    // when 2+ samples are available. Clamped 0.7x-1.5x to absorb outliers.
    function seasonalProjection(targetMonth: string): { value: number; sampleYears: number } {
      const parts = targetMonth.split("-");
      const targetYear = parseInt(parts[0], 10);
      const mm = parts[1];
      const samples: number[] = [];
      for (let y = 1; y <= 3; y++) {
        const past = String(targetYear - y) + "-" + mm;
        const v = revByMonth.get(past);
        if (v !== undefined && v > 0) samples.push(v);
      }
      if (samples.length === 0) return { value: 0, sampleYears: 0 };
      let projected = samples.reduce((a, b) => a + b, 0) / samples.length;
      if (samples.length >= 2 && samples[1] > 0) {
        const yoy = samples[0] / samples[1];
        const clampedYoy = Math.max(0.7, Math.min(1.5, yoy));
        projected = samples[0] * clampedYoy;
      }
      return { value: Math.round(projected), sampleYears: samples.length };
    }

    // Recent 3-month weighted moving average (existing logic kept as fallback).
    const recent3 = completedRows.slice(-3);
    let movingAvg = avgMonthly;
    if (recent3.length === 3) {
      movingAvg = Math.round(
        monthRev(recent3[2]) * 0.5 + monthRev(recent3[1]) * 0.3 + monthRev(recent3[0]) * 0.2,
      );
    } else if (recent3.length === 2) {
      movingAvg = Math.round(monthRev(recent3[1]) * 0.6 + monthRev(recent3[0]) * 0.4);
    } else if (recent3.length === 1) {
      movingAvg = Math.round(monthRev(recent3[0]));
    }

    type ForecastEntry = {
      month: string;
      value: number;
      basis: "pace" | "seasonal" | "ma" | "blend";
    };
    const forecast: ForecastEntry[] = [];

    // Current month: prefer a blend of pace + seasonal when both available.
    {
      const seasonal = seasonalProjection(currentMonth);
      let value: number;
      let basis: ForecastEntry["basis"];
      if (seasonal.sampleYears >= 1 && currentMonthSoFar > 0) {
        value = Math.round(paceProjection * 0.6 + seasonal.value * 0.4);
        basis = "blend";
      } else if (currentMonthSoFar > 0) {
        value = paceProjection;
        basis = "pace";
      } else if (seasonal.sampleYears >= 1) {
        value = seasonal.value;
        basis = "seasonal";
      } else {
        value = movingAvg;
        basis = "ma";
      }
      // Never project below what's already realised this month.
      value = Math.max(value, currentMonthSoFar);
      forecast.push({ month: currentMonth, value, basis });
    }

    // MoM growth rate from up to last 6 completed months (geometric mean).
    // Used so future-month MA fallbacks aren't flat — each month differs.
    const last6 = completedRows.slice(-6);
    let momGrowth = 0;
    if (last6.length >= 2) {
      const oldest = monthRev(last6[0]);
      const latest = monthRev(last6[last6.length - 1]);
      if (oldest > 0 && latest > 0) {
        const periods = last6.length - 1;
        const raw = Math.pow(latest / oldest, 1 / periods) - 1;
        momGrowth = Math.max(-0.15, Math.min(0.2, raw));
      }
    }

    // Future months: blend per-month seasonal with MoM-grown moving avg.
    // Each future month gets a different growth multiplier i → i+1 → i+2.
    for (let i = 1; i <= 3; i++) {
      const fd = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const targetMonth = fd.toISOString().slice(0, 7);
      const seasonal = seasonalProjection(targetMonth);
      const grownMa = Math.round(movingAvg * Math.pow(1 + momGrowth, i));
      let value: number;
      let basis: ForecastEntry["basis"];
      if (seasonal.sampleYears >= 1) {
        value = Math.round(seasonal.value * 0.65 + grownMa * 0.35);
        basis = "blend";
      } else {
        value = grownMa;
        basis = "ma";
      }
      forecast.push({ month: targetMonth, value, basis });
    }

    const currentMonthTarget = forecast[0]?.value ?? movingAvg;

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
      currentMonthTarget,
      currentMonth,
    };
  },
});

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
