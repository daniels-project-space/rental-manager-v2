import { query } from "./_generated/server";
import { v } from "convex/values";

// ── Helper: derive effective date (pickup_date takes priority per BF-06) ──
const effectiveDateStr = (r: { pickup_date?: string; start_date?: string }): string | undefined =>
  r.pickup_date ?? r.start_date;

const TODAY = () => new Date().toISOString().slice(0, 10);

const effectiveDate = (r: { pickup_date?: string; start_date?: string }): string | undefined =>
  r.pickup_date ?? r.start_date;

const isoWeekBounds = () => {
  const now = new Date();
  const day = now.getDay();
  const diffToMon = (day === 0 ? -6 : 1 - day);
  const mon = new Date(now);
  mon.setDate(now.getDate() + diffToMon);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { weekStart: mon.toISOString().slice(0, 10), weekEnd: sun.toISOString().slice(0, 10) };
};

const monthBounds = () => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  return { monthStart: start, monthEnd: end };
};

/**
 * W02 Stats Grid -- single query returning all stat-tile values.
 * Active rental segmentation matching v1 booking-stats logic:
 *   ongoing  = confirmed AND start_date <= today AND end_date >= today
 *   upcoming = confirmed AND start_date > today
 *   overdue  = confirmed AND end_date < today (stale -- not yet marked complete)
 * Revenue attribution uses effectiveDate = pickup_date ?? start_date (BF-06).
 */
export const getSummary = query({
  args: { accountSlug: v.union(v.string(), v.null()) },
  handler: async (ctx, { accountSlug }) => {
    const today = TODAY();
    const { weekStart, weekEnd } = isoWeekBounds();
    const { monthStart, monthEnd } = monthBounds();

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().slice(0, 10);

    let allReservations = await ctx.db.query("reservations").collect();
    if (accountSlug) {
      allReservations = allReservations.filter((r) => r.account_slug === accountSlug);
    }

    // Active rental segmentation
    const confirmedWithDates = allReservations.filter(
      (r) => r.status === "confirmed" && r.start_date !== undefined && r.end_date !== undefined
    );
    const ongoingCount = confirmedWithDates.filter(
      (r) => (r.start_date as string) <= today && (r.end_date as string) >= today
    ).length;
    const upcomingCount = confirmedWithDates.filter(
      (r) => (r.start_date as string) > today
    ).length;
    const activeRentalsCount = ongoingCount + upcomingCount;
    const pendingReturns = confirmedWithDates.filter((r) => r.end_date === today).length;
    const overdueCount = confirmedWithDates.filter((r) => (r.end_date as string) < today).length;

    // Revenue: non-cancelled, effective date <= today (BF-06)
    const earnedRows = allReservations.filter((r) => {
      if (r.status === "cancelled" || r.status === "declined") return false;
      const d = effectiveDate(r);
      return d !== undefined && d <= today;
    });

    const todayRevenue = earnedRows.filter((r) => effectiveDate(r) === today)
      .reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);
    const todayRentalCount = earnedRows.filter((r) => effectiveDate(r) === today).length;
    const weeklyRevenue = earnedRows
      .filter((r) => { const d = effectiveDate(r) as string; return d >= weekStart && d <= weekEnd; })
      .reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);
    const monthlyRevenue = earnedRows
      .filter((r) => { const d = effectiveDate(r) as string; return d >= monthStart && d <= monthEnd; })
      .reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);
    const monthlyBookings = allReservations.filter((r) => {
      if (r.status === "cancelled" || r.status === "declined") return false;
      const d = effectiveDate(r);
      return d !== undefined && d >= monthStart && d <= monthEnd;
    }).length;

    // Month projection
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysElapsed = now.getDate();
    const daysRemaining = daysInMonth - daysElapsed;
    const dailyAvgRevenue = daysElapsed > 0 ? monthlyRevenue / daysElapsed : 0;
    const bookedCurrentMonth = confirmedWithDates
      .filter((r) => { const d = r.start_date as string; return d > today && d >= monthStart && d <= monthEnd; })
      .reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);
    const projectedMonthRevenue = Math.round(monthlyRevenue + bookedCurrentMonth + dailyAvgRevenue * daysRemaining);

    // Avg rental value last 30d
    const last30 = earnedRows.filter((r) => (effectiveDate(r) as string) >= thirtyDaysAgoStr);
    const avgRentalValue = last30.length > 0
      ? last30.reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0) / last30.length : 0;

    // Items currently out (from ongoing rentals only)
    const itemNamesOut = new Set<string>();
    for (const r of confirmedWithDates.filter(
      (r) => (r.start_date as string) <= today && (r.end_date as string) >= today
    )) {
      for (const item of r.items ?? []) itemNamesOut.add(item.item_name);
    }
    const itemsOut = itemNamesOut.size;

    const allItems = await ctx.db.query("items").collect();
    const activeItems = allItems.filter((i) => i.status === "active" && !i.is_marketing_only);
    const availableItems = activeItems.filter((i) => !itemNamesOut.has(i.name_canonical)).length;
    const totalAcquisitionCost = activeItems.reduce((s, i) => s + (i.acquisition_cost_gbp ?? 0), 0);

    // Denials (90d for denied revenue, 30d for denial rate)
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    let denials = await ctx.db.query("denial_records").collect();
    if (accountSlug) {
      const acct = await ctx.db.query("accounts")
        .withIndex("by_slug", (q) => q.eq("slug", accountSlug as string)).first();
      if (acct) denials = denials.filter((d) => d.account_id === acct._id);
    }
    const pricingRows = await ctx.db.query("pricing_catalog").collect();
    const priceByName = new Map(pricingRows.map((p) => [p.item_name_canonical, p.daily_price_min]));
    let deniedRevenue = 0;
    const denials90 = denials.filter((d) => d.created_at >= ninetyDaysAgo.getTime());
    for (const d of denials90) {
      if (d.estimated_value) deniedRevenue += d.estimated_value;
      else if (d.item_name) deniedRevenue += (priceByName.get(d.item_name) ?? 0) * 2;
    }
    const recentDenials30 = denials.filter((d) => d.created_at >= thirtyDaysAgo.getTime()).length;
    const denialRate = monthlyBookings + recentDenials30 > 0
      ? recentDenials30 / (monthlyBookings + recentDenials30) : 0;

    // Out-of-stock (items fully booked in next 14 days)
    const fourteenDaysStr = new Date(now.getTime() + 14 * 86400000).toISOString().slice(0, 10);
    const holdCounts = new Map<string, number>();
    for (const r of confirmedWithDates.filter(
      (r) => (r.start_date as string) <= fourteenDaysStr && (r.end_date as string) >= today
    )) {
      for (const item of r.items ?? []) holdCounts.set(item.item_name, (holdCounts.get(item.item_name) ?? 0) + 1);
    }
    const outOfStockCount = activeItems.filter(
      (i) => (holdCounts.get(i.name_canonical) ?? 0) >= i.qty
    ).length;

    const settings = await ctx.db.query("settings").first();
    // Stage 2.5: read boostRate from settings (no hardcoded constant)
    const boostRate: number = (settings as unknown as Record<string, number>)?.ai_boost_rate ?? 0.33;
    const aiBoostAmount = Math.round(monthlyRevenue * boostRate / (1 + boostRate));

    return {
      activeRentalsCount, ongoingCount, upcomingCount,
      pendingReturns, overdueCount,
      todayRevenue: Math.round(todayRevenue * 100) / 100,
      todayRentalCount,
      weeklyRevenue: Math.round(weeklyRevenue * 100) / 100,
      monthlyRevenue: Math.round(monthlyRevenue * 100) / 100,
      monthlyBookings, projectedMonthRevenue, daysElapsed, daysRemaining,
      dailyAvgRevenue: Math.round(dailyAvgRevenue * 100) / 100,
      avgRentalValue: Math.round(avgRentalValue * 100) / 100,
      itemsOut, availableItems,
      totalAcquisitionCost: Math.round(totalAcquisitionCost),
      outOfStockCount,
      denialRate: Math.round(denialRate * 1000) / 1000,
      deniedRevenue: Math.round(deniedRevenue),
      deniedCount: denials90.length,
      aiBoostAmount, boostRate,
      hyggloSendEnabled: settings?.ALLOW_HYGGLO_SEND ?? false,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// W02 Stats Drawer — single reactive query powering all 16 stat-card drawers.
//
// Pre-fetch strategy: one query, 5 collect() calls total (reservations, items,
// denial_records, owner_unavailability, sync_state). All 16 card payloads are
// derived from these in-memory with zero extra round-trips.
//
// Cards with no real data source return placeholder zeros / empty arrays;
// each is marked TODO so callers can render empty-state gracefully.
// ─────────────────────────────────────────────────────────────────────────────

/** Order steps that represent a live paid/active booking (non-obsolete). */
const ACTIVE_ORDER_STEPS = new Set([
  "FUNDS_RESERVED",
  "VERIFIED",
  "BOOKED_AFTER_VERIFIED",
  "DELIVERED",
  "RETURNED",
  "REVIEWED",
]);

export const getStatsDrawerData = query({
  args: { accountSlug: v.union(v.string(), v.null()) },
  handler: async (ctx, { accountSlug }) => {
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date();

    // ── Week bounds ──────────────────────────────────────────────
    const dayOfWeek = now.getDay();
    const diffToMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monDate = new Date(now);
    monDate.setDate(now.getDate() + diffToMon);
    const weekStart = monDate.toISOString().slice(0, 10);
    const sunDate = new Date(monDate);
    sunDate.setDate(monDate.getDate() + 6);
    const weekEnd = sunDate.toISOString().slice(0, 10);

    // ── Month bounds ─────────────────────────────────────────────
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysElapsed = now.getDate();
    const daysRemaining = daysInMonth - daysElapsed;

    // ── Next-30-day window for out-of-stock calc ─────────────────
    const next30 = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);

    // ── COLLECT 1: reservations ──────────────────────────────────
    let allRes = await ctx.db.query("reservations").collect();
    if (accountSlug) {
      allRes = allRes.filter((r) => r.account_slug === accountSlug);
    }

    // ── COLLECT 2: items ─────────────────────────────────────────
    let allItems = await ctx.db.query("items").collect();
    if (accountSlug) {
      // items are cross-account; no slug filter needed for inventory_worth
      // but keep full list for out-of-stock which is also cross-account
    }
    const activeItems = allItems.filter((i) => i.status === "active" && !i.is_marketing_only);

    // ── COLLECT 3: denial_records ────────────────────────────────
    let denialRows = await ctx.db.query("denial_records").collect();
    if (accountSlug) {
      // denial_records only have account_id; resolve via accounts if needed
      // (slug filter applied below per-card — keep full list here)
    }

    // ── COLLECT 4: owner_unavailability ─────────────────────────
    const unavailRows = await ctx.db.query("owner_unavailability").collect();

    // ── COLLECT 5: sync_state ─────────────────────────────────────
    const syncRow = await ctx.db
      .query("sync_state")
      .withIndex("by_source", (q) => q.eq("source", "hygglo_poller"))
      .first();

    // ────────────────────────────────────────────────────────────
    // Derived sets from reservations
    // ────────────────────────────────────────────────────────────

    // Confirmed (non-obsolete, non-cancelled) with dates
    const confirmedWithDates = allRes.filter(
      (r) =>
        r.status === "confirmed" &&
        !r.is_obsolete &&
        r.start_date !== undefined &&
        r.end_date !== undefined,
    );

    // Active = ongoing + upcoming (from confirmed set)
    const ongoingRentals = confirmedWithDates.filter(
      (r) => (r.start_date as string) <= today && (r.end_date as string) >= today,
    );
    const upcomingRentals = confirmedWithDates.filter(
      (r) => (r.start_date as string) > today,
    );

    // Paid (any non-cancelled/declined) for revenue
    const paidRes = allRes.filter(
      (r) => r.status !== "cancelled" && r.status !== "declined" && !r.is_obsolete,
    );

    // Monthly confirmed bookings
    const monthConfirmedRentals = confirmedWithDates.filter((r) => {
      const d = effectiveDateStr(r);
      return d !== undefined && d >= monthStart && d <= monthEnd;
    });

    // Revenue slices
    const earnedPaid = paidRes.filter((r) => {
      const d = effectiveDateStr(r);
      return d !== undefined && d <= today;
    });
    const todayEarned = earnedPaid.filter((r) => effectiveDateStr(r) === today);
    const weekEarned = earnedPaid.filter((r) => {
      const d = effectiveDateStr(r) as string;
      return d >= weekStart && d <= weekEnd;
    });
    const monthEarned = earnedPaid.filter((r) => {
      const d = effectiveDateStr(r) as string;
      return d >= monthStart && d <= monthEnd;
    });

    const todayTotal = todayEarned.reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);
    const weekTotal = weekEarned.reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);
    const monthTotal = monthEarned.reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);

    // Per-account earnings breakdown
    const accountSlugs = [...new Set(allRes.map((r) => r.account_slug).filter(Boolean))] as string[];
    const byAccount = accountSlugs.map((slug) => {
      const todayAcc = todayEarned
        .filter((r) => r.account_slug === slug)
        .reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);
      const weekAcc = weekEarned
        .filter((r) => r.account_slug === slug)
        .reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);
      return { account_slug: slug, today: Math.round(todayAcc * 100) / 100, week: Math.round(weekAcc * 100) / 100 };
    });

    // Month projection
    const avgDailyRate = daysElapsed > 0 ? monthTotal / daysElapsed : 0;
    const bookedFuture = confirmedWithDates
      .filter((r) => {
        const d = r.start_date as string;
        return d > today && d >= monthStart && d <= monthEnd;
      })
      .reduce((s, r) => s + (r.gross_paid_gbp ?? 0), 0);
    const projected = Math.round(monthTotal + bookedFuture + avgDailyRate * daysRemaining);

    // ── card: active ─────────────────────────────────────────────
    const activeTotal = ongoingRentals.length + upcomingRentals.length;
    const activeRentals = [...ongoingRentals, ...upcomingRentals].slice(0, 15).map((r) => ({
      reservation_id: r.v1_rental_id ?? r.hygglo_order_id ?? r._id,
      renter_name: r.renter_name ?? null,
      account_slug: r.account_slug ?? "",
      start_date: r.start_date ?? null,
      end_date: r.end_date ?? null,
      items: (r.items ?? []).map((i) => i.item_name),
      order_step: r.order_step ?? null,
    }));

    // ── card: earnings ───────────────────────────────────────────
    const earnings = {
      today: Math.round(todayTotal * 100) / 100,
      week: Math.round(weekTotal * 100) / 100,
      by_account: byAccount,
    };

    // ── card: monthly ────────────────────────────────────────────
    const monthly = {
      current_earnings: Math.round(monthTotal * 100) / 100,
      projected,
      days_remaining: daysRemaining,
      avg_daily_rate: Math.round(avgDailyRate * 100) / 100,
    };

    // ── card: confirmed ──────────────────────────────────────────
    const confirmed = {
      month_count: monthConfirmedRentals.length,
      rentals: monthConfirmedRentals.slice(0, 15).map((r) => ({
        reservation_id: r.v1_rental_id ?? r.hygglo_order_id ?? r._id,
        renter_name: r.renter_name ?? null,
        start_date: r.start_date ?? null,
        end_date: r.end_date ?? null,
        gross: r.gross_paid_gbp ?? null,
      })),
    };

    // ── card: ongoing ─────────────────────────────────────────────
    const ongoingCard = {
      count: ongoingRentals.length,
      rentals: ongoingRentals.slice(0, 15).map((r) => {
        const daysLeft = r.end_date
          ? Math.max(0, Math.round((Date.parse(r.end_date) - Date.now()) / 86400000))
          : null;
        return {
          reservation_id: r.v1_rental_id ?? r.hygglo_order_id ?? r._id,
          renter_name: r.renter_name ?? null,
          start_date: r.start_date ?? null,
          end_date: r.end_date ?? null,
          items: (r.items ?? []).map((i) => i.item_name),
          days_left: daysLeft,
        };
      }),
    };

    // ── card: upcoming ────────────────────────────────────────────
    const upcomingCard = {
      count: upcomingRentals.length,
      rentals: upcomingRentals.slice(0, 15).map((r) => {
        const daysUntil = r.start_date
          ? Math.max(0, Math.round((Date.parse(r.start_date) - Date.now()) / 86400000))
          : null;
        return {
          reservation_id: r.v1_rental_id ?? r.hygglo_order_id ?? r._id,
          renter_name: r.renter_name ?? null,
          pickup_date: r.pickup_date ?? r.start_date ?? null,
          pickup_time: r.pickup_time ?? null,
          items: (r.items ?? []).map((i) => i.item_name),
          days_until: daysUntil,
        };
      }),
    };

    // ── card: scanner ─────────────────────────────────────────────
    const scanner = {
      last_scan_at: syncRow?.lastRunAt ?? null,
      last_run_succeeded: syncRow?.lastRunSucceeded ?? null,
      rows_upserted_last: syncRow?.rowsUpserted?.reservations ?? 0,
    };

    // ── card: denied_revenue ──────────────────────────────────────
    // denial_records: no reservation_id or renter_name; best-effort mapping
    const ninetyDaysAgo = Date.now() - 90 * 86400000;
    const recentDenials = denialRows.filter((d) => d.created_at >= ninetyDaysAgo);
    const deniedRevenueTotal = recentDenials.reduce((s, d) => s + (d.estimated_value ?? 0), 0);
    const denied_revenue = {
      total_gbp: Math.round(deniedRevenueTotal * 100) / 100,
      items: recentDenials.slice(0, 15).map((d) => ({
        reservation_id: d._id as string,
        renter_name: null as string | null,
        gross: d.estimated_value ?? null,
        reason: d.reason ?? null,
      })),
    };

    // ── card: missed_revenue ──────────────────────────────────────
    // TODO: wire when missed-revenue source exists (separate from denied).
    // For now mirrors denied_revenue as a placeholder.
    const missed_revenue = {
      total_gbp: 0 as number,
      items: [] as Array<{ reservation_id: string; renter_name: string | null; gross: number | null; reason: string | null }>,
    };

    // ── card: ai_boost ────────────────────────────────────────────
    // TODO: wire to ai_decisions / settings.ai_boost_rate when source is stable.
    // Placeholder: return zeros. getSummary already computes aiBoostAmount.
    const ai_boost = {
      total_uplift_gbp: 0 as number,
      breakdown: [] as Array<{ source: string; amount: number }>,
    };

    // ── card: out_of_stock ────────────────────────────────────────
    // Items where confirmed bookings in next 30d cover all their qty.
    const holdCountsByItem = new Map<string, number>();
    for (const r of confirmedWithDates) {
      if ((r.start_date as string) <= next30 && (r.end_date as string) >= today) {
        for (const it of r.items ?? []) {
          holdCountsByItem.set(it.item_name, (holdCountsByItem.get(it.item_name) ?? 0) + 1);
        }
      }
    }
    const oosItems = activeItems
      .filter((i) => (holdCountsByItem.get(i.name_canonical) ?? 0) >= i.qty)
      .slice(0, 15)
      .map((i) => {
        // count how many of the next 30 days have holds
        let blockedDays = 0;
        const itemHolds = confirmedWithDates.filter((r) =>
          (r.items ?? []).some((it) => it.item_name === i.name_canonical) &&
          (r.start_date as string) <= next30 &&
          (r.end_date as string) >= today,
        );
        // simple day-count: iterate each hold span
        for (const r of itemHolds) {
          const s = new Date(Math.max(Date.parse(r.start_date as string), Date.now()));
          const e = new Date(Math.min(Date.parse(r.end_date as string), Date.now() + 30 * 86400000));
          blockedDays += Math.max(0, Math.round((e.getTime() - s.getTime()) / 86400000) + 1);
        }
        return {
          item_id: i._id as string,
          name: i.name_canonical,
          blocked_days_next_30: Math.min(30, blockedDays),
        };
      });
    const out_of_stock = {
      count: oosItems.length,
      items: oosItems,
    };

    // ── card: vacation ────────────────────────────────────────────
    // owner_unavailability joined with items for name
    const itemNameById = new Map(allItems.map((i) => [i._id as string, i.name_canonical]));
    const activeBlocks = unavailRows
      .filter((u) => u.end_date >= today)
      .slice(0, 20)
      .map((u) => ({
        item_name: itemNameById.get(u.item_id as string) ?? u.item_id,
        start: u.start_date,
        end: u.end_date,
        reason: u.reason ?? null,
      }));
    const vacation = { active_blocks: activeBlocks };

    // ── card: sell_reco ───────────────────────────────────────────
    // TODO: wire to lost_revenue.getPurchaseRecommendations when drawer is built.
    // Placeholder empty.
    const sell_reco = {
      recommendations: [] as Array<{ item_name: string; reason: string; suggested_price_gbp: number | null }>,
    };

    // ── card: inventory_worth ─────────────────────────────────────
    const worthByKind = new Map<string, number>();
    for (const i of activeItems) {
      const cost = i.acquisition_cost_gbp ?? 0;
      worthByKind.set(i.kind, (worthByKind.get(i.kind) ?? 0) + cost);
    }
    const totalWorth = activeItems.reduce((s, i) => s + (i.acquisition_cost_gbp ?? 0), 0);
    const inventory_worth = {
      total_gbp: Math.round(totalWorth),
      by_category: Array.from(worthByKind.entries())
        .sort(([, a], [, b]) => b - a)
        .map(([kind, value]) => ({ kind, value: Math.round(value) })),
    };

    // ── card: tax ─────────────────────────────────────────────────
    // TODO: wire to historical_revenue + annual tax computation when confirmed.
    // Placeholder empty.
    const tax = {
      years: [] as Array<{ year: number; gross: number; estimated_tax: number }>,
    };

    // ── card: business_intel ──────────────────────────────────────
    // TODO: wire to ai_insights / purchase_signals MV when drawer is built.
    // Placeholder empty.
    const business_intel = {
      kpis: [] as Array<{ label: string; value: string; badge: "strong" | "moderate" | "watch" }>,
    };

    return {
      active: {
        total: activeTotal,
        rentals: activeRentals,
      },
      earnings,
      monthly,
      confirmed,
      ongoing: ongoingCard,
      upcoming: upcomingCard,
      scanner,
      denied_revenue,
      missed_revenue,
      ai_boost,
      out_of_stock,
      vacation,
      sell_reco,
      inventory_worth,
      tax,
      business_intel,
    };
  },
});
