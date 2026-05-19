import { query } from "./_generated/server";
import { v } from "convex/values";
import { dedupByLogicalRental, effectiveDate, isLive } from "./lib/reservations/predicates";
import { diagnoseDenialAvailability } from "./lib/availability";
import {
  buildCommitmentMap,
  diagnoseDenialCapacity,
  isCompletedCommitting,
} from "./lib/capacity_gap";

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
    // Exclude cancelled/declined/obsolete reservations. Earlier code used the
    // typo "denied" (matched zero rows because schema enum is "declined");
    // canonicalised via isLive from predicates so revenue, dashboard and chat
    // all use the same definition.
    rows = rows.filter(isLive);

    const buckets = new Map<string, { revenue: number; bookings: number }>();

    for (const r of rows) {
      // BF-06: use pickup_date if available, fall back to start_date
      const dateStr = effectiveDate(r as any);
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
    // Headline 'total missed' is denials only (concrete demand we declined).
    // Idle-gap is informational — it assumes 100% utilization as baseline,
    // which inflates the number 3-5x vs realistic targets. v1 chat reports
    // denials + unavailable as 'lost revenue', NOT idle capacity. Keeping
    // gapTotal separate so the agent can mention it without combining.
    const totalMissed = denialTotal;

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

    // 2-year window for lifetime ROI scorecard. Same trade-off as
    // intel.ts:getItemROIRanking — forward-safe today, migrate to MV when
    // history > 2y.
    const roiScorecardCutoff = new Date(Date.now() - 730 * 86400000)
      .toISOString()
      .slice(0, 10);
    let reservations = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", roiScorecardCutoff))
      .collect();
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

    // getLifetimeByMonth feeds the lifetime chart — by definition needs
    // full history. The cost-watch ratchet allows this once flagged:
    // a future PR should back this with an MV (one row per (month, account)
    // refreshed nightly). // check-patterns:ok
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

    // Insurance claims — only those EXPLICITLY credited to a month by the
    // owner (stage='added_to_revenue') contribute to the lifetime chart.
    // payout_amount_gbp is the recovered figure (may differ from amount_gbp).
    // Source: pipeline in InsuranceClaimsDrawer.tsx → creditToRevenue mutation.
    const allClaims = await ctx.db.query("insurance_claims").collect();
    const claimsByMonth = new Map<string, number>();
    for (const c of allClaims) {
      if (accountSlug && c.account_slug !== accountSlug) continue;
      const credited = (c as any).credited_to_month as string | undefined;
      const payout   = (c as any).payout_amount_gbp as number | undefined;
      if (!credited || !payout) continue;
      claimsByMonth.set(credited, r2((claimsByMonth.get(credited) ?? 0) + payout));
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

    // Dedup by canonical logical-rental key (hygglo_order_id > v1_rental_id
    // > renter+dates+account composite). Collisions keep the row with the
    // highest net_to_owner_gbp — revenue-safe vs the prior "keep first".
    // Shared with dashboard.getStatsDrawerData via dedupByLogicalRental.
    const dedupedFiltered = dedupByLogicalRental(filtered as any) as typeof filtered;

    for (const res of dedupedFiltered) {
      const dateStr = effectiveDate(res as any);
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
            const d = effectiveDate(r as any);
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

    // Include the current (partial) month in totals for BOTH per-account and
    // all-accounts views — the chart shows the bar for it, so the header total
    // must include it. Otherwise users see the bar but no £ attribution.
    const completedRows = rows.filter(
      (row) =>
        row.month <= currentMonth &&
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

/**
 * Phase 9.1 — Missed/Denied by Category (two-ring pie data).
 *
 * Outer ring: total missed (denials + idle-gap) per kind.
 * Inner ring: denials only per kind (same kinds order as outer).
 * 7th "Unmatched" slice for denial rows whose item_name doesn't resolve.
 *
 * Reuses the algorithm from getMissedRevenue verbatim, grouping by kind.
 */
const MISSED_KIND_LABELS: Record<string, string> = {
  camera: "Cameras", lens: "Lenses", drone: "Drones", audio: "Audio",
  lighting: "Lighting", grip: "Grip", gimbal: "Gimbals", monitor: "Monitors",
  transmission: "Transmission", accessory: "Accessories", smoke_fx: "Smoke/FX",
  dj_audio: "DJ Audio", power: "Power", storage_card: "Storage", support: "Support",
  motion: "Motion", stabilizer: "Stabilizers", video: "Video", effects: "Effects",
  bundle: "Bundles", unknown: "Unknown", other: "Other",
};
const MISSED_PALETTE = ["#fde047", "#fbbf24", "#f59e0b", "#fb923c", "#f97316", "#ef4444"];
const MISSED_OTHER_COLOR = "#7f1d1d";
const MISSED_UNMATCHED_COLOR = "#94a3b8";

function missedLabelFor(k: string): string {
  return MISSED_KIND_LABELS[k] ?? (k.charAt(0).toUpperCase() + k.slice(1));
}

export const getMissedAndDeniedByCategory = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.number(),
  },
  handler: async (ctx, { accountSlug, days }) => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffMs = cutoff.getTime();
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const periodStart = cutoffStr;

    // Phase 6 — new denial classifier is the only path. Denied slice counts
    // ONLY reservations where Daniel actively denied (reclassified_outcome /
    // denial_actor = "owner_denied"). Renter-cancelled / ghosted / system
    // rows are excluded.

    // 1. Build kind maps from items. Phase 9.2: prefer item_id FK (resolved
    //    at write time by the LLM) over name_canonical string matching.
    const allItems = await ctx.db.query("items").collect();
    const nameToKind = new Map<string, string>();
    const idToKind = new Map<string, string>();
    for (const it of allItems) {
      const kind = it.kind ?? "unknown";
      if (it.name_canonical) nameToKind.set(it.name_canonical, kind);
      idToKind.set(it._id, kind);
    }

    // pricing fallback for denial value
    const pricingRows = await ctx.db.query("pricing_catalog").collect();
    const priceByName = new Map(
      pricingRows.map((p) => [p.item_name_canonical, p.daily_price_min]),
    );

    // 2. Denials path — feature-flagged (Phase 3c).
    const deniedByKind = new Map<string, { revenue: number; count: number }>();
    let unmatchedRevenue = 0;
    let unmatchedCount = 0;
    let totalDeniedRevenue = 0;
    // `deniedRecordCount` mirrors the original `denials.length` semantic so the
    // returned `denied.totals.count` shape is unchanged. Under the new path it
    // tracks owner_denied reservation rows.
    let deniedRecordCount = 0;

    // Count only reservations where Daniel actively denied.
    // Source = reservations table filtered by reclassified_outcome (Phase 3a
    // re-classifier output). Fall back to denial_actor if reclassified is
    // missing on an older row.
    let obsoleteRes = await ctx.db
      .query("reservations")
      .filter((q) => q.eq(q.field("is_obsolete"), true))
      .collect();
    if (accountSlug) {
      obsoleteRes = obsoleteRes.filter((r) => r.account_slug === accountSlug);
    }
    // Cutoff: prefer obsolete_at, then v1_updated_at, then _creationTime.
    obsoleteRes = obsoleteRes.filter((r) => {
      const ts = r.obsolete_at ?? r.v1_updated_at ?? r._creationTime;
      return ts >= cutoffMs;
    });
    const ownerDenied = obsoleteRes.filter((r) => {
      const actor = r.reclassified_outcome ?? r.denial_actor;
      return actor === "owner_denied";
    });

    for (const r of ownerDenied) {
      // EstimatedValue: prefer gross_paid_gbp (rare on denials), else
      // first resolved_item daily_price * duration_days fallback, else 0.
      let estimatedValue = r.gross_paid_gbp ?? 0;
      const firstItem = (r.items ?? [])[0];
      const itemNameForLookup =
        (r.resolved_items ?? [])[0]?.item_name_canonical ??
        firstItem?.item_name;
      if (estimatedValue === 0 && itemNameForLookup) {
        const dp = priceByName.get(itemNameForLookup);
        if (dp) estimatedValue = dp * Math.max(1, r.duration_days ?? 2);
      }
      totalDeniedRevenue += estimatedValue;
      deniedRecordCount += 1;

      // Kind lookup: resolved_items[0].item_id → canonical name → items[0].item_name → unmatched.
      let kind: string | undefined;
      const resolved = (r.resolved_items ?? [])[0];
      if (resolved?.item_id) kind = idToKind.get(resolved.item_id);
      if (!kind && resolved?.item_name_canonical) {
        kind = nameToKind.get(resolved.item_name_canonical);
      }
      if (!kind && firstItem?.item_name) {
        kind = nameToKind.get(firstItem.item_name);
      }
      if (!kind) {
        unmatchedRevenue += estimatedValue;
        unmatchedCount += 1;
        continue;
      }
      const slot = deniedByKind.get(kind) ?? { revenue: 0, count: 0 };
      slot.revenue += estimatedValue;
      slot.count += 1;
      deniedByKind.set(kind, slot);
    }

    // 3. Gap + Demand path (Phase 6 — new gap/demand engine is the only path).
    //
    // Iterate owner_denied reservations. For each, diagnose per-item
    // availability over the requested date range using a commitment map built
    // from COMPLETED rentals. Attribute the rental's estimated value
    // (gross_paid_gbp or pricing fallback) split evenly across the items
    // that drove the denial.
    //
    // Marketing-only path: items.is_marketing_only=true → gap.marketing_only
    // Fully-booked path : all units busy on ≥1 requested date → gap.fully_booked
    // Available-anyway  : Daniel had inventory → voluntary_demand_lost
    //                     (does NOT count as gap, but tracked for demand)
    //
    // Phase 7.8 — `use_new_gap_demand` flag separates Denied/Gap from Demand.
    // When ON (default), owner_denied rows feed ONLY denied + gap; Demand is
    // sourced from a separate population: renter-side cancellations / ghosts /
    // paid-then-system-failed rows that exclude owner_denied. This eliminates
    // the historical double-count where a single rental could be classified as
    // both owner_denied (Denied) AND demand_loss_class=genuine_demand (Demand).
    // When OFF, retain Phase 6 behavior — every owner_denied row also adds to
    // demand — for instant rollback safety.
    const useNewGapDemand = true;
    const gapByKind = new Map<string, number>();
    const gapBreakdown = {
      marketing_only: 0,
      fully_booked: 0,
      voluntary_demand_lost: 0,
    };
    const demandByKind = new Map<string, number>();
    let totalDemandLost = 0;

    let obsoleteResAll = await ctx.db
      .query("reservations")
      .filter((q) => q.eq(q.field("is_obsolete"), true))
      .collect();
    if (accountSlug) {
      obsoleteResAll = obsoleteResAll.filter(
        (r) => r.account_slug === accountSlug,
      );
    }
    obsoleteResAll = obsoleteResAll.filter((r) => {
      const ts = r.obsolete_at ?? r.v1_updated_at ?? r._creationTime;
      return ts >= cutoffMs;
    });
    const ownerDeniedAll = obsoleteResAll.filter((r) => {
      const actor = r.reclassified_outcome ?? r.denial_actor;
      return actor === "owner_denied";
    });

    // Build a commitment map from COMPLETED rentals (status confirmed/completed,
    // not obsolete) covering the cutoff window forward.
    const completedAll = await ctx.db
      .query("reservations")
      .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
      .collect();
    const completedScoped = accountSlug
      ? completedAll.filter((c) => c.account_slug === accountSlug)
      : completedAll;
    const commitMap = buildCommitmentMap(
      completedScoped.filter(isCompletedCommitting),
    );

    for (const r of ownerDeniedAll) {
      // diagnoseDenialCapacity does its own £ estimation (same fallback).
      const diag = await diagnoseDenialCapacity(
        ctx,
        r,
        commitMap,
        priceByName,
      );
      const estimated = diag.estimated_loss_gbp;
      const totalBuckets = diag.per_item_diagnosis.length;
      if (estimated <= 0 || totalBuckets === 0) continue;

      // Share by item — equal split across the items that drove the denial.
      const sharePer = estimated / totalBuckets;

      for (const p of diag.per_item_diagnosis) {
        const itemIdStr = p.item_id ? String(p.item_id) : undefined;
        const kind = itemIdStr ? idToKind.get(itemIdStr) ?? "unknown" : "unknown";
        if (p.classification === "marketing_only") {
          gapBreakdown.marketing_only += sharePer;
          gapByKind.set(kind, (gapByKind.get(kind) ?? 0) + sharePer);
          if (!useNewGapDemand) {
            demandByKind.set(kind, (demandByKind.get(kind) ?? 0) + sharePer);
            totalDemandLost += sharePer;
          }
        } else if (p.classification === "capacity_gap") {
          gapBreakdown.fully_booked += sharePer;
          gapByKind.set(kind, (gapByKind.get(kind) ?? 0) + sharePer);
          if (!useNewGapDemand) {
            demandByKind.set(kind, (demandByKind.get(kind) ?? 0) + sharePer);
            totalDemandLost += sharePer;
          }
        } else {
          // voluntary
          gapBreakdown.voluntary_demand_lost += sharePer;
          if (!useNewGapDemand) {
            demandByKind.set(kind, (demandByKind.get(kind) ?? 0) + sharePer);
            totalDemandLost += sharePer;
          }
        }
      }
    }

    // Phase 7.8 — NEW demand path (flag ON).
    // Demand = obsolete AND NOT owner_denied AND (
    //   denial_actor in {renter_cancelled_explicit, renter_ghosted}
    //   OR (denial_actor null/system_or_other AND gross_paid_gbp > 0)
    // )
    // Mutually exclusive with Denied + Gap (those are sourced from owner_denied).
    if (useNewGapDemand) {
      const demandRows = obsoleteResAll.filter((r) => {
        const actor = r.reclassified_outcome ?? r.denial_actor;
        if (actor === "owner_denied") return false;
        if (actor === "renter_cancelled_explicit") return true;
        if (actor === "renter_ghosted") return true;
        // paid-then-system-failed: no actor or system_or_other AND money changed hands
        if ((actor == null || actor === "system_or_other") &&
            (r.gross_paid_gbp ?? 0) > 0) return true;
        return false;
      });

      for (const r of demandRows) {
        // Estimated value: gross_paid_gbp || gross_gbp || duration × daily_price
        let estimatedValue = r.gross_paid_gbp ?? 0;
        if (estimatedValue === 0) {
          // gross_gbp may not exist on schema; fall back to pricing catalog
          const firstItem = (r.items ?? [])[0];
          const itemNameForLookup =
            (r.resolved_items ?? [])[0]?.item_name_canonical ??
            firstItem?.item_name;
          if (itemNameForLookup) {
            const dp = priceByName.get(itemNameForLookup);
            if (dp) estimatedValue = dp * Math.max(1, r.duration_days ?? 2);
          }
        }
        if (estimatedValue <= 0) continue;

        // Per-item attribution: split evenly across resolved items (consistent
        // with gap path which splits across per_item_diagnosis entries).
        const resolved = r.resolved_items ?? [];
        const items = r.items ?? [];
        const itemCount = Math.max(resolved.length, items.length, 1);
        const sharePer = estimatedValue / itemCount;

        for (let i = 0; i < itemCount; i++) {
          let kind: string | undefined;
          const ri = resolved[i];
          if (ri?.item_id) kind = idToKind.get(ri.item_id);
          if (!kind && ri?.item_name_canonical) {
            kind = nameToKind.get(ri.item_name_canonical);
          }
          if (!kind && items[i]?.item_name) {
            kind = nameToKind.get(items[i].item_name);
          }
          const k = kind ?? "unknown";
          demandByKind.set(k, (demandByKind.get(k) ?? 0) + sharePer);
          totalDemandLost += sharePer;
        }
      }
    }

    // 4. Combine per-kind totals.
    const allKinds = new Set<string>([
      ...deniedByKind.keys(),
      ...gapByKind.keys(),
      ...demandByKind.keys(),
    ]);
    type Combined = {
      kind: string;
      missed: number;
      denied: number;
      gap: number;
      demandLost: number;
      count: number;
    };
    const combined: Combined[] = [];
    for (const k of allKinds) {
      const d = deniedByKind.get(k) ?? { revenue: 0, count: 0 };
      const g = gapByKind.get(k) ?? 0;
      const dem = demandByKind.get(k) ?? 0;
      const missed = d.revenue + g + dem;
      if (missed <= 0) continue;
      combined.push({
        kind: k,
        missed: r2(missed),
        denied: r2(d.revenue),
        gap: r2(g),
        demandLost: r2(dem),
        count: d.count,
      });
    }
    combined.sort((a, b) => b.missed - a.missed);

    // 5. Top-6 + Other for outer ring.
    const top = combined.slice(0, 6);
    const rest = combined.slice(6);
    const outerSlices: Array<{
      kind: string; label: string; missed: number; denied: number; gap: number; demandLost: number; revenue: number; color: string;
    }> = top.map((c, i) => ({
      kind: c.kind,
      label: missedLabelFor(c.kind),
      missed: c.missed,
      denied: c.denied,
      gap: c.gap,
      demandLost: c.demandLost,
      revenue: c.missed,
      color: MISSED_PALETTE[i] ?? MISSED_PALETTE[MISSED_PALETTE.length - 1],
    }));
    if (rest.length > 0) {
      const oMissed = rest.reduce((s, c) => s + c.missed, 0);
      const oDenied = rest.reduce((s, c) => s + c.denied, 0);
      const oGap = rest.reduce((s, c) => s + c.gap, 0);
      const oDemand = rest.reduce((s, c) => s + c.demandLost, 0);
      outerSlices.push({
        kind: "other",
        label: "Other",
        missed: r2(oMissed),
        denied: r2(oDenied),
        gap: r2(oGap),
        demandLost: r2(oDemand),
        revenue: r2(oMissed),
        color: MISSED_OTHER_COLOR,
      });
    }
    if (unmatchedRevenue > 0) {
      outerSlices.push({
        kind: "unmatched",
        label: "Unmatched",
        missed: r2(unmatchedRevenue),
        denied: r2(unmatchedRevenue),
        gap: 0,
        demandLost: 0,
        revenue: r2(unmatchedRevenue),
        color: MISSED_UNMATCHED_COLOR,
      });
    }

    // 6. Inner ring — denied only, same order as outer for visual alignment.
    const innerSlices: Array<{ kind: string; label: string; denied: number; revenue: number; count: number; color: string }> = [];
    const restKinds = new Set(rest.map((c) => c.kind));
    for (const o of outerSlices) {
      if (o.kind === "unmatched") {
        if (unmatchedRevenue > 0) {
          innerSlices.push({
            kind: "unmatched",
            label: "Unmatched",
            denied: r2(unmatchedRevenue),
            revenue: r2(unmatchedRevenue),
            count: unmatchedCount,
            color: MISSED_UNMATCHED_COLOR,
          });
        }
        continue;
      }
      if (o.kind === "other") {
        const oDenied = rest.reduce((s, c) => s + c.denied, 0);
        const oCount = rest.reduce((s, c) => s + c.count, 0);
        if (oDenied > 0) {
          innerSlices.push({
            kind: "other",
            label: "Other",
            denied: r2(oDenied),
            revenue: r2(oDenied),
            count: oCount,
            color: MISSED_OTHER_COLOR,
          });
        }
        continue;
      }
      const c = combined.find((cc) => cc.kind === o.kind);
      if (!c || c.denied <= 0) continue;
      innerSlices.push({
        kind: c.kind,
        label: missedLabelFor(c.kind),
        denied: c.denied,
        revenue: c.denied,
        count: c.count,
        color: o.color,
      });
      // suppress unused-var warning
      void restKinds;
    }

    const totalMissed = combined.reduce((s, c) => s + c.missed, 0) + unmatchedRevenue;
    const totalGap = combined.reduce((s, c) => s + c.gap, 0);
    const totalDeniedCount = deniedRecordCount;

    return {
      days,
      periodStart,
      missed: {
        slices: outerSlices,
        totals: {
          missed: r2(totalMissed),
          denied: r2(totalDeniedRevenue),
          gap: r2(totalGap),
          demandLost: r2(totalDemandLost),
        },
      },
      denied: {
        slices: innerSlices,
        totals: {
          denied: r2(totalDeniedRevenue),
          count: totalDeniedCount,
        },
      },
      unmatchedDenials: {
        revenue: r2(unmatchedRevenue),
        count: unmatchedCount,
      },
    };
  },
});

/**
 * Phase 7.5 — Missed-mode drill-down (per-item breakdown within a kind).
 *
 * Returns per-item slices for a specific kind within the Missed view, so
 * clicking a kind ring in Missed mode reveals which individual items drove
 * the loss. Parity with `dashboard:getRentalVolumeKindBreakdown` (Earned).
 *
 * `view` selects the component:
 *   - "denied"  : only owner_denied reservations (mirrors inner ring)
 *   - "gap"     : capacity_gap + marketing_only diagnoses
 *   - "demand"  : voluntary_demand_lost + gap (all demand the owner couldn't fulfil)
 *   - "all"     : total missed (denied + gap + demand) — matches outer ring
 */
export const getMissedKindBreakdown = query({
  args: {
    accountSlug: v.union(v.string(), v.null()),
    days: v.number(),
    kind: v.string(),
    view: v.optional(v.union(
      v.literal("all"),
      v.literal("denied"),
      v.literal("gap"),
      v.literal("demand"),
    )),
  },
  handler: async (ctx, { accountSlug, days, kind, view }) => {
    const effView = view ?? "all";
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffMs = cutoff.getTime();
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // Build kind maps from items.
    const allItems = await ctx.db.query("items").collect();
    const itemById = new Map<string, { kind: string; name: string }>();
    const itemKindByCanonical = new Map<string, string>();
    for (const it of allItems) {
      const k = it.kind ?? "unknown";
      const name = (it as { name_canonical?: string }).name_canonical ?? String(it._id);
      itemById.set(String(it._id), { kind: k, name });
      if ((it as { name_canonical?: string }).name_canonical) {
        itemKindByCanonical.set((it as { name_canonical?: string }).name_canonical!, k);
      }
    }

    const pricingRows = await ctx.db.query("pricing_catalog").collect();
    const priceByName = new Map(
      pricingRows.map((p) => [p.item_name_canonical, p.daily_price_min]),
    );

    // Owner-denied reservations within the window.
    let obsoleteRes = await ctx.db
      .query("reservations")
      .filter((q) => q.eq(q.field("is_obsolete"), true))
      .collect();
    if (accountSlug) {
      obsoleteRes = obsoleteRes.filter((r) => r.account_slug === accountSlug);
    }
    obsoleteRes = obsoleteRes.filter((r) => {
      const ts = r.obsolete_at ?? r.v1_updated_at ?? r._creationTime;
      return ts >= cutoffMs;
    });
    const ownerDenied = obsoleteRes.filter((r) => {
      const actor = r.reclassified_outcome ?? r.denial_actor;
      return actor === "owner_denied";
    });

    // Per-item aggregator. Each item gets {revenue, count} bucket.
    const perItem = new Map<string, { name: string; revenue: number; count: number }>();
    const bumpItem = (id: string, name: string, revenue: number) => {
      const slot = perItem.get(id) ?? { name, revenue: 0, count: 0 };
      slot.revenue += revenue;
      slot.count += 1;
      perItem.set(id, slot);
    };

    // Denied component: attribute the whole estimated value to the first
    // resolved item (matches how the outer/inner denied math is computed).
    if (effView === "all" || effView === "denied") {
      for (const r of ownerDenied) {
        let estimatedValue = r.gross_paid_gbp ?? 0;
        const firstItem = (r.items ?? [])[0];
        const resolved0 = (r.resolved_items ?? [])[0];
        const itemNameForLookup =
          resolved0?.item_name_canonical ?? firstItem?.item_name;
        if (estimatedValue === 0 && itemNameForLookup) {
          const dp = priceByName.get(itemNameForLookup);
          if (dp) estimatedValue = dp * Math.max(1, r.duration_days ?? 2);
        }
        if (estimatedValue <= 0) continue;

        // Resolve kind for this item; only contribute if it matches `kind`.
        let resolvedKind: string | undefined;
        let itemId: string | undefined;
        let itemName: string | undefined;
        if (resolved0?.item_id) {
          itemId = String(resolved0.item_id);
          const info = itemById.get(itemId);
          resolvedKind = info?.kind;
          itemName = info?.name ?? resolved0.item_name_canonical;
        }
        if (!resolvedKind && resolved0?.item_name_canonical) {
          resolvedKind = itemKindByCanonical.get(resolved0.item_name_canonical);
          itemName = resolved0.item_name_canonical;
          itemId = itemId ?? resolved0.item_name_canonical;
        }
        if (!resolvedKind && firstItem?.item_name) {
          resolvedKind = itemKindByCanonical.get(firstItem.item_name);
          itemName = firstItem.item_name;
          itemId = itemId ?? firstItem.item_name;
        }
        if (!resolvedKind || resolvedKind !== kind) continue;
        bumpItem(itemId ?? itemName ?? "unknown", itemName ?? "Unknown", estimatedValue);
      }
    }

    // Gap + demand components: use diagnoseDenialCapacity per reservation.
    if (effView === "all" || effView === "gap" || effView === "demand") {
      // Build commitment map from completed reservations.
      const completedAll = await ctx.db
        .query("reservations")
        .withIndex("by_start_date", (q) => q.gte("start_date", cutoffStr))
        .collect();
      const completedScoped = accountSlug
        ? completedAll.filter((c) => c.account_slug === accountSlug)
        : completedAll;
      const commitMap = buildCommitmentMap(
        completedScoped.filter(isCompletedCommitting),
      );

      for (const r of ownerDenied) {
        const diag = await diagnoseDenialCapacity(ctx, r, commitMap, priceByName);
        const estimated = diag.estimated_loss_gbp;
        const totalBuckets = diag.per_item_diagnosis.length;
        if (estimated <= 0 || totalBuckets === 0) continue;
        const sharePer = estimated / totalBuckets;

        for (const p of diag.per_item_diagnosis) {
          const itemIdStr = p.item_id ? String(p.item_id) : undefined;
          const info = itemIdStr ? itemById.get(itemIdStr) : undefined;
          const itemKind = info?.kind ?? "unknown";
          if (itemKind !== kind) continue;

          const cls = p.classification;
          let includeAsGap = false;
          let includeAsDemand = false;
          if (cls === "capacity_gap" || cls === "marketing_only") {
            includeAsGap = true;
            includeAsDemand = true;
          } else {
            // voluntary
            includeAsDemand = true;
          }
          const shouldInclude =
            effView === "all"
              ? includeAsDemand // demand subsumes gap
              : effView === "gap"
                ? includeAsGap
                : effView === "demand"
                  ? includeAsDemand
                  : false;
          if (!shouldInclude) continue;
          bumpItem(
            itemIdStr ?? "unknown",
            info?.name ?? "Unknown",
            sharePer,
          );
        }
      }
    }

    // Sort, slice top-15, attach colours.
    const PALETTE = [
      "#fde047", "#fbbf24", "#f59e0b", "#fb923c", "#f97316",
      "#ef4444", "#ec4899", "#a78bfa", "#60a5fa", "#22d3ee",
      "#34d399", "#84cc16", "#eab308", "#d946ef", "#8b5cf6",
    ];
    const entries = Array.from(perItem.entries())
      .map(([id, v]) => ({ itemId: id, name: v.name, count: v.count, revenue: r2(v.revenue) }))
      .filter((e) => e.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue);
    const items_out = entries.slice(0, 15).map((e, i) => ({
      ...e,
      color: PALETTE[i % PALETTE.length],
    }));

    const totals = {
      count: items_out.reduce((s, e) => s + e.count, 0),
      revenue: r2(items_out.reduce((s, e) => s + e.revenue, 0)),
    };

    return {
      days,
      periodStart: cutoffStr,
      kind,
      kindLabel: missedLabelFor(kind),
      view: effView,
      items: items_out,
      totals,
    };
  },
});
