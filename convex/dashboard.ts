import { query } from "./_generated/server";
import { v } from "convex/values";

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
    const boostRate = 0.34;
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
